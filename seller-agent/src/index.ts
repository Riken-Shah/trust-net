import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import postgres from "postgres";
import { z } from "zod";
import { runIngestion } from "./ingest.js";

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

const INSERT_REVIEW_SQL = `
	INSERT INTO reviews (agent_id, reviewer_address, verification_tx, score, score_accuracy, score_speed, score_value, score_reliability, comment)
	VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
	RETURNING id, created_at`;

const GET_REVIEWS_SQL = `
	SELECT
		r.id, r.reviewer_address, r.verification_tx,
		r.score, r.score_accuracy, r.score_speed, r.score_value, r.score_reliability,
		r.comment, r.created_at,
		a.name AS agent_name
	FROM reviews r
	JOIN agents a ON a.id = r.agent_id
	WHERE r.agent_id = $1
	ORDER BY r.created_at DESC`;

const BASE_SEPOLIA_RPC = "https://sepolia.base.org";

async function verifyBurnTx(txHash: string, reviewerAddress: string): Promise<{ valid: boolean; error?: string }> {
	try {
		const resp = await fetch(BASE_SEPOLIA_RPC, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getTransactionByHash", params: [txHash], id: 1 }),
			signal: AbortSignal.timeout(10_000),
		});
		const data = await resp.json() as { result?: { from?: string } };
		if (!data.result) return { valid: false, error: "Transaction not found on Base Sepolia" };
		if (data.result.from?.toLowerCase() !== reviewerAddress.toLowerCase()) {
			return { valid: false, error: "Transaction sender does not match reviewer address" };
		}
		return { valid: true };
	} catch (e) {
		return { valid: false, error: `RPC error: ${e instanceof Error ? e.message : String(e)}` };
	}
}

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

		this.server.tool(
			"submit_review",
			"Submit a review for an agent. Requires a burn transaction hash for verification.",
			{
				agent_id: z.string().describe("UUID of the agent to review"),
				reviewer_address: z.string().describe("Wallet address of the reviewer"),
				verification_tx: z.string().describe("Burn transaction hash for verification"),
				score: z.number().min(1).max(10).describe("Overall score (1-10)"),
				score_accuracy: z.number().min(1).max(10).optional().describe("Accuracy score (1-10)"),
				score_speed: z.number().min(1).max(10).optional().describe("Speed score (1-10)"),
				score_value: z.number().min(1).max(10).optional().describe("Value score (1-10)"),
				score_reliability: z.number().min(1).max(10).optional().describe("Reliability score (1-10)"),
				comment: z.string().optional().describe("Optional review comment"),
			},
			async (params) => {
				const resp = await fetch(`${workerUrl}/api/reviews`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(params),
				});
				const data = await resp.json() as { error?: string };
				if (!resp.ok) {
					return { content: [{ type: "text" as const, text: `Error: ${data.error || resp.statusText}` }], isError: true };
				}
				return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
			},
		);

		this.server.tool(
			"get_reviews",
			"Get all reviews for a specific agent.",
			{
				agent_id: z.string().describe("UUID of the agent"),
			},
			async (params) => {
				const resp = await fetch(`${workerUrl}/api/reviews?agent_id=${params.agent_id}`);
				const data = await resp.json() as { error?: string };
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

		// --- Reviews API ---
		if (url.pathname === "/api/reviews") {
			try {
				const sql = postgres(env.HYPERDRIVE.connectionString, { max: 1, idle_timeout: 5, prepare: false });

				if (request.method === "GET") {
					const agentId = url.searchParams.get("agent_id");
					if (!agentId) {
						await sql.end();
						return Response.json({ error: "agent_id query parameter is required" }, { status: 400 });
					}
					const rows = await sql.unsafe(GET_REVIEWS_SQL, [agentId]);
					await sql.end();
					return Response.json({ reviews: rows });
				}

				if (request.method === "POST") {
					const body = await request.json() as Record<string, unknown>;
					const agentId = body.agent_id as string;
					const reviewerAddress = body.reviewer_address as string;
					const verificationTx = body.verification_tx as string;
					const score = body.score as number;

					if (!agentId || !reviewerAddress || !verificationTx || !score) {
						await sql.end();
						return Response.json({ error: "Missing required fields: agent_id, reviewer_address, verification_tx, score" }, { status: 400 });
					}
					if (score < 1 || score > 10) {
						await sql.end();
						return Response.json({ error: "score must be between 1 and 10" }, { status: 400 });
					}

					// Verify burn tx on-chain
					const txCheck = await verifyBurnTx(verificationTx, reviewerAddress);
					if (!txCheck.valid) {
						await sql.end();
						return Response.json({ error: `Transaction verification failed: ${txCheck.error}` }, { status: 400 });
					}

					const rows = await sql.unsafe(INSERT_REVIEW_SQL, [
						agentId, reviewerAddress, verificationTx, score,
						(body.score_accuracy as number) ?? null,
						(body.score_speed as number) ?? null,
						(body.score_value as number) ?? null,
						(body.score_reliability as number) ?? null,
						(body.comment as string) ?? null,
					]);
					await sql.end();
					return Response.json({ review: rows[0] }, { status: 201 });
				}

				await sql.end();
				return Response.json({ error: "Method not allowed" }, { status: 405 });
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

					if (toolName === "submit_review" && planId) {
						const paymentRequired = buildPaymentRequired(planId, { endpoint: "/mcp", agentId, httpVerb: "POST" });
						const verification = await verifyPermissions(paymentRequired, token, CREDITS_PER_CALL);
						if (!verification.isValid) {
							return Response.json({
								jsonrpc: "2.0",
								error: { code: -32000, message: verification.invalidReason || "Payment verification failed" },
								id: body.id ?? null,
							}, { status: 402 });
						}

						const args = (body.params as any)?.arguments ?? {};
						try {
							const sql = postgres(env.HYPERDRIVE.connectionString, { max: 1, idle_timeout: 5, prepare: false });

							if (!args.agent_id || !args.reviewer_address || !args.verification_tx || !args.score) {
								await sql.end();
								return Response.json({
									jsonrpc: "2.0",
									error: { code: -32602, message: "Missing required fields: agent_id, reviewer_address, verification_tx, score" },
									id: body.id ?? null,
								}, { status: 400 });
							}

							const txCheck = await verifyBurnTx(args.verification_tx, args.reviewer_address);
							if (!txCheck.valid) {
								await sql.end();
								return Response.json({
									jsonrpc: "2.0",
									error: { code: -32000, message: `Transaction verification failed: ${txCheck.error}` },
									id: body.id ?? null,
								}, { status: 400 });
							}

							const rows = await sql.unsafe(INSERT_REVIEW_SQL, [
								args.agent_id, args.reviewer_address, args.verification_tx, args.score,
								args.score_accuracy ?? null, args.score_speed ?? null,
								args.score_value ?? null, args.score_reliability ?? null,
								args.comment ?? null,
							]);
							await sql.end();

							const settlement = await settlePermissions(paymentRequired, token, CREDITS_PER_CALL, verification.agentRequestId);

							return Response.json({
								jsonrpc: "2.0",
								result: {
									content: [{ type: "text", text: JSON.stringify({ review: rows[0] }, null, 2) }],
									_meta: {
										creditsRedeemed: settlement.creditsRedeemed,
										remainingBalance: settlement.remainingBalance,
										transaction: settlement.transaction,
									},
								},
								id: body.id ?? null,
							});
						} catch (err) {
							return Response.json({
								jsonrpc: "2.0",
								error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
								id: body.id ?? null,
							});
						}
					}

					if (toolName === "get_reviews" && planId) {
						const paymentRequired = buildPaymentRequired(planId, { endpoint: "/mcp", agentId, httpVerb: "POST" });
						const verification = await verifyPermissions(paymentRequired, token, CREDITS_PER_CALL);
						if (!verification.isValid) {
							return Response.json({
								jsonrpc: "2.0",
								error: { code: -32000, message: verification.invalidReason || "Payment verification failed" },
								id: body.id ?? null,
							}, { status: 402 });
						}

						const args = (body.params as any)?.arguments ?? {};
						try {
							const sql = postgres(env.HYPERDRIVE.connectionString, { max: 1, idle_timeout: 5, prepare: false });
							if (!args.agent_id) {
								await sql.end();
								return Response.json({
									jsonrpc: "2.0",
									error: { code: -32602, message: "agent_id is required" },
									id: body.id ?? null,
								}, { status: 400 });
							}
							const rows = await sql.unsafe(GET_REVIEWS_SQL, [args.agent_id]);
							await sql.end();

							const settlement = await settlePermissions(paymentRequired, token, CREDITS_PER_CALL, verification.agentRequestId);

							return Response.json({
								jsonrpc: "2.0",
								result: {
									content: [{ type: "text", text: JSON.stringify({ reviews: rows }, null, 2) }],
									_meta: {
										creditsRedeemed: settlement.creditsRedeemed,
										remainingBalance: settlement.remainingBalance,
										transaction: settlement.transaction,
									},
								},
								id: body.id ?? null,
							});
						} catch (err) {
							return Response.json({
								jsonrpc: "2.0",
								error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
								id: body.id ?? null,
							});
						}
					}
				}

				// Handle tools/list
				if (body.method === "tools/list") {
					return Response.json({
						jsonrpc: "2.0",
						result: {
							tools: [
								{
									name: "list_agents",
									description: "List all agents with trust scores, payment plans, service info, and computed stats.",
									inputSchema: { type: "object", properties: {} },
								},
								{
									name: "submit_review",
									description: "Submit a review for an agent. Requires a burn transaction hash for verification.",
									inputSchema: {
										type: "object",
										properties: {
											agent_id: { type: "string", description: "UUID of the agent to review" },
											reviewer_address: { type: "string", description: "Wallet address of the reviewer" },
											verification_tx: { type: "string", description: "Burn transaction hash for verification" },
											score: { type: "number", description: "Overall score (1-10)", minimum: 1, maximum: 10 },
											score_accuracy: { type: "number", description: "Accuracy score (1-10)", minimum: 1, maximum: 10 },
											score_speed: { type: "number", description: "Speed score (1-10)", minimum: 1, maximum: 10 },
											score_value: { type: "number", description: "Value score (1-10)", minimum: 1, maximum: 10 },
											score_reliability: { type: "number", description: "Reliability score (1-10)", minimum: 1, maximum: 10 },
											comment: { type: "string", description: "Optional review comment" },
										},
										required: ["agent_id", "reviewer_address", "verification_tx", "score"],
									},
								},
								{
									name: "get_reviews",
									description: "Get all reviews for a specific agent.",
									inputSchema: {
										type: "object",
										properties: {
											agent_id: { type: "string", description: "UUID of the agent" },
										},
										required: ["agent_id"],
									},
								},
							],
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

	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(
			runIngestion(env)
				.then((result) => console.log("Ingestion complete:", JSON.stringify(result)))
				.catch((err) => console.error("Ingestion failed:", err)),
		);
	},
};
