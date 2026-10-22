/**
 * Sidebar Manager — Host half.
 *
 * Public extension point only: registers owner-authenticated exact Fetch routes
 * under `/api/local/sidebar/*` through `ctx.connection.fetch` (client-connection).
 * The transaction core lives in `./transaction.mjs`; this package never imports
 * `@deepseek-ai/*` runtime modules and never patches the DSH installation.
 */
import { createTransactionRoutes, finalizePending, resolveOptions } from './transaction.mjs'

export const name = 'sidebar-manager'

/**
 * Services used by the routes and the boot finalizer. `apply` only awaits the
 * finalizer after every injected service is available; a failure is logged and
 * leaves the journal in place for the next start.
 */
export const inject = [
  'connection',
  'workspaceRegistry',
  'sessionPersistence',
  'agents',
  'sessions',
]

export async function apply(ctx, config = {}) {
  const options = resolveOptions(config)
  const routes = createTransactionRoutes(ctx, options)
  for (const [suffix, fetch] of Object.entries(routes)) {
    ctx.effect(
      () =>
        ctx.connection.fetch.register({
          path: `/api/local/sidebar/${suffix}`,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch,
        }),
      `sidebar-manager: ${suffix}`,
    )
  }
  try {
    const result = await finalizePending(ctx, options)
    if (result.state !== 'none') ctx.logger?.info?.('sidebar-manager journal finalized', result)
  } catch (error) {
    ctx.logger?.warn?.('sidebar-manager boot finalizer failed; journal retained', error)
  }
  ctx.logger?.info?.('sidebar-manager routes registered', {
    count: Object.keys(routes).length,
    stateDir: options.stateDir,
  })
}
