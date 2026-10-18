// No secrets or OAuth tokens are exposed to the static app. All persistence is
// encrypted and durable; missing activation configuration fails closed.
module.exports = async function privateSync(req, res) {
  const { default: handler } = await import('../server/private-sync/handler.mjs');
  return handler(req, res);
};
