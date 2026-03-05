export class DbConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DbConfigError'
  }
}
