import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import postgres from "postgres";

// ─── x402 Payment Types ─────────────────────────────────────────
interface X402PaymentRequired {
	x402Version: number;
	resource: { url: string; description?: string };
	accepts: Array<{
		scheme: string;
		network: string;
		planId: string;
		extra?: { agentId?: string; httpVerb?: string };
	}>;
	extensions: Record<string, unknown>;
}

interface VerifyResult {
	isValid: boolean;
	invalidReason?: string;
	payer?: string;
	agentRequestId?: string;
}

interface SettleResult {
	success: boolean;
	errorReason?: string;
	transaction: string;
	network: string;
	creditsRedeemed?: string;
	remainingBalance?: string;
}

// ─── x402 Helpers ────────────────────────────────────────────────

const NVM_BACKEND = "https://api.sandbox.nevermined.app";
const VERIFY_URL = `${NVM_BACKEND}/api/v1/x402/verify`;
const SETTLE_URL = `${NVM_BACKEND}/api/v1/x402/settle`;

function buildPaymentRequired(planId: string, opts: {
	endpoint?: string;
	agentId?: string;
	httpVerb?: string;
}): X402PaymentRequired {
	const extra = opts.agentId || opts.httpVerb
		? { ...(opts.agentId && { agentId: opts.agentId }), ...(opts.httpVerb && { httpVerb: opts.httpVerb }) }
		: undefined;
	return {
		x402Version: 2,
		resource: { url: opts.endpoint || "" },
		accepts: [{ scheme: "nvm:erc4337", network: "eip155:84532", planId, ...(extra && { extra }) }],
		extensions: {},
	};
}

async function verifyPermissions(paymentRequired: X402PaymentRequired, token: string, maxAmount: number): Promise<VerifyResult> {
	const resp = await fetch(VERIFY_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({ paymentRequired, x402AccessToken: token, maxAmount: maxAmount.toString() }),
	});
	if (!resp.ok) {
		const err = await resp.json().catch(() => ({})) as Record<string, string>;
		return { isValid: false, invalidReason: err.message || `HTTP ${resp.status}` };
	}
	return await resp.json() as VerifyResult;
}

async function settlePermissions(paymentRequired: X402PaymentRequired, token: string, maxAmount: number, agentRequestId?: string): Promise<SettleResult> {
	const body: Record<string, unknown> = { paymentRequired, x402AccessToken: token, maxAmount: maxAmount.toString() };
	if (agentRequestId) body.agentRequestId = agentRequestId;
	const resp = await fetch(SETTLE_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify(body),
	});
	if (!resp.ok) {
		const err = await resp.json().catch(() => ({})) as Record<string, string>;
		return { success: false, errorReason: err.message || `HTTP ${resp.status}`, transaction: "", network: "" };
	}
	return await resp.json() as SettleResult;
}

// ─── SQL ─────────────────────────────────────────────────────────

const LIST_AGENTS_SQL = `
	SELECT
		a.id AS agent_id, a.team_name, a.name, a.description,
		a.category, a.keywords, a.marketplace_ready, a.endpoint_url,
		COALESCE(ts.trust_score, 0) AS trust_score, ts.tier,
		COALESCE(ts.review_count, 0) AS review_count
	FROM agents a
	LEFT JOIN trust_scores ts ON ts.agent_id = a.id
	WHERE a.is_active = TRUE
	ORDER BY COALESCE(ts.trust_score, 0) DESC, a.name ASC`;

// ─── MCP Agent (Durable Object) ─────────────────────────────────

export class MyMCP extends McpAgent {
	server = new McpServer({ name: "trust-net", version: "1.0.0" });

	async init() {
		const workerUrl = this.env.WORKER_URL || "https://trust-net-mcp.rikenshah-02.workers.dev";

		this.server.tool(
			"list_agents",
			"List all agents with trust scores, payment plans, service info, and computed stats.",
			{},
			async () => {
				const resp = await fetch(`${workerUrl}/api/agents`);
				const data = await resp.json() as { items?: unknown[]; error?: string };
				if (!resp.ok) {
					return { content: [{ type: "text" as const, text: `Error: ${data.error || resp.statusText}` }], isError: true };
				}
				return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
			},
		);
	}
}

// ─── Worker fetch handler ────────────────────────────────────────

const CREDITS_PER_CALL = 1;

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		// --- Direct DB query (used by MCP tool internally) ---
		if (url.pathname === "/api/agents") {
			try {
				const sql = postgres(env.HYPERDRIVE.connectionString, { max: 1, idle_timeout: 5, prepare: false });
				const rows = await sql.unsafe(LIST_AGENTS_SQL);
				await sql.end();
				return Response.json({ items: rows });
			} catch (err) {
				return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
			}
		}

		// --- Payment-protected API endpoint ---
		if (url.pathname === "/api/paid/agents") {
			const planId = env.NVM_PLAN_ID;
			const agentId = env.SELLER_AGENT_ID || "";
			if (!planId) {
				return Response.json({ error: "Server misconfigured: NVM_PLAN_ID not set" }, { status: 500 });
			}

			const token = request.headers.get("payment-signature");
			const paymentRequired = buildPaymentRequired(planId, {
				endpoint: "/api/paid/agents",
				agentId,
				httpVerb: request.method,
			});

			if (!token) {
				const encoded = btoa(JSON.stringify(paymentRequired));
				return new Response(JSON.stringify({ error: "Payment Required" }), {
					status: 402,
					headers: {
						"Content-Type": "application/json",
						"payment-required": encoded,
					},
				});
			}

			// Step 1: Verify
			const verification = await verifyPermissions(paymentRequired, token, CREDITS_PER_CALL);
			if (!verification.isValid) {
				return new Response(JSON.stringify({ error: verification.invalidReason || "Payment verification failed" }), {
					status: 402,
					headers: { "Content-Type": "application/json" },
				});
			}

			// Step 2: Execute
			let items: unknown[];
			try {
				const sql = postgres(env.HYPERDRIVE.connectionString, { max: 1, idle_timeout: 5, prepare: false });
				items = await sql.unsafe(LIST_AGENTS_SQL) as unknown[];
				await sql.end();
			} catch (err) {
				return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
			}

			// Step 3: Settle (burn credits)
			const settlement = await settlePermissions(paymentRequired, token, CREDITS_PER_CALL, verification.agentRequestId);
			const paymentResponse = btoa(JSON.stringify(settlement));

			return new Response(JSON.stringify({ items }), {
				status: 200,
				headers: {
					"Content-Type": "application/json",
					"payment-response": paymentResponse,
				},
			});
		}

		// --- Stateless JSON-RPC /mcp with x402 payment (for test-client compatibility) ---
		// If POST /mcp has Authorization header and no Mcp-Session-Id, handle inline
		if (url.pathname === "/mcp" && request.method === "POST") {
			const authHeader = request.headers.get("authorization");
			const sessionHeader = request.headers.get("mcp-session-id");

			if (authHeader && !sessionHeader) {
				const token = authHeader.replace(/^Bearer\s+/i, "");
				const body = await request.json() as { jsonrpc: string; method: string; params?: Record<string, unknown>; id?: number | string | null };

				// Handle tools/call for list_agents with payment
				if (body.method === "tools/call") {
					const toolName = (body.params as any)?.name;
					const planId = env.NVM_PLAN_ID;
					const agentId = env.SELLER_AGENT_ID || "";

					if (toolName === "list_agents" && planId) {
						const paymentRequired = buildPaymentRequired(planId, {
							endpoint: "/mcp",
							agentId,
							httpVerb: "POST",
						});

						// Step 1: Verify
						const verification = await verifyPermissions(paymentRequired, token, CREDITS_PER_CALL);
						if (!verification.isValid) {
							return Response.json({
								jsonrpc: "2.0",
								error: { code: -32000, message: verification.invalidReason || "Payment verification failed" },
								id: body.id ?? null,
							}, { status: 402 });
						}

						// Step 2: Execute
						let items: unknown[];
						try {
							const sql = postgres(env.HYPERDRIVE.connectionString, { max: 1, idle_timeout: 5, prepare: false });
							items = await sql.unsafe(LIST_AGENTS_SQL) as unknown[];
							await sql.end();
						} catch (err) {
							return Response.json({
								jsonrpc: "2.0",
								error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
								id: body.id ?? null,
							});
						}

						// Step 3: Settle
						const settlement = await settlePermissions(paymentRequired, token, CREDITS_PER_CALL, verification.agentRequestId);

						return Response.json({
							jsonrpc: "2.0",
							result: {
								content: [{ type: "text", text: JSON.stringify({ items }, null, 2) }],
								_meta: {
									creditsRedeemed: settlement.creditsRedeemed,
									remainingBalance: settlement.remainingBalance,
									transaction: settlement.transaction,
								},
							},
							id: body.id ?? null,
						});
					}
				}

				// Handle tools/list
				if (body.method === "tools/list") {
					return Response.json({
						jsonrpc: "2.0",
						result: {
							tools: [{
								name: "list_agents",
								description: "List all agents with trust scores, payment plans, service info, and computed stats.",
								inputSchema: { type: "object", properties: {} },
							}],
						},
						id: body.id ?? null,
					});
				}

				// Handle initialize
				if (body.method === "initialize") {
					return Response.json({
						jsonrpc: "2.0",
						result: {
							protocolVersion: "2024-11-05",
							capabilities: { tools: { listChanged: true } },
							serverInfo: { name: "trust-net", version: "1.0.0" },
						},
						id: body.id ?? null,
					});
				}

				// Unknown method
				return Response.json({
					jsonrpc: "2.0",
					error: { code: -32601, message: `Method not found: ${body.method}` },
					id: body.id ?? null,
				});
			}
		}

		// --- MCP protocol (SSE / Streamable HTTP with session) ---
		if (url.pathname === "/sse" || url.pathname === "/mcp") {
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}

		// --- Health ---
		if (url.pathname === "/health") {
			return Response.json({ status: "ok", service: "trust-net-mcp" });
		}

		return new Response("Not found", { status: 404 });
	},
};
