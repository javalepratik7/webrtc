// Controllers hold the logic for a request. Routes only decide WHICH controller runs.

export function getHealth(req, res) {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}
