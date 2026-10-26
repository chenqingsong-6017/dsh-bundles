/**
 * Host half — this plugin is a pure browser surface. The slider lives in
 * `lib/client.js` and talks to the official Session model RPC through
 * `ctx.remote.session`; nothing has to run on the Host, so `apply` only exists
 * to give the Loader row a body.
 */
export const name = '@local/dsh-reasoning-slider'

export function apply() {}
