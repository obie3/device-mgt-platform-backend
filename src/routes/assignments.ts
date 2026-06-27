import { FastifyInstance } from 'fastify';

/** Escape user-supplied text before embedding in HTML. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

export default async function assignmentRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/v1/assignments/:token/ack
   *
   * Public — no session auth. Shows a confirmation page so the employee can
   * explicitly click "Confirm receipt". Does NOT mark acknowledged on GET —
   * GET must be idempotent so link previews, crawlers, and prefetch requests
   * don't silently acknowledge the assignment.
   */
  fastify.get('/assignments/:token/ack', async (request, reply) => {
    const { token } = request.params as { token: string };

    const assignment = await fastify.prisma.deviceAssignment.findUnique({
      where: { acknowledgeToken: token },
      include: {
        device: { select: { model: true, serial: true } },
        employee: { select: { name: true } },
      },
    });

    if (!assignment) {
      return reply
        .status(404)
        .type('text/html')
        .send(buildPage('Link not found', '<h1>Link not found</h1><p>This acknowledgment link is invalid or has already been used.</p>'));
    }

    if (assignment.returnedAt) {
      return reply
        .type('text/html')
        .send(buildPage('Device returned', '<h1>Device already returned</h1><p>This device has already been returned. No action needed.</p>'));
    }

    if (
      assignment.acknowledgeExpiresAt &&
      assignment.acknowledgeExpiresAt < new Date()
    ) {
      return reply
        .status(410)
        .type('text/html')
        .send(buildPage('Link expired', '<h1>Link expired</h1><p>This acknowledgment link has expired. Please contact IT for a new one.</p>'));
    }

    if (assignment.acknowledgedAt) {
      // Already acknowledged — show confirmation without the form
      return reply
        .type('text/html')
        .send(
          buildPage(
            'Already acknowledged',
            `<h1 class="ok">✓ Already confirmed</h1>
             <p>Hi <strong>${esc(assignment.employee.name)}</strong>,</p>
             <p>You have already acknowledged receipt of <strong>${esc(assignment.device.model)}</strong> (${esc(assignment.device.serial)}).</p>`
          )
        );
    }

    // Render confirmation form — mutation happens on POST
    const html = `
      <h1>Confirm receipt</h1>
      <p>Hi <strong>${esc(assignment.employee.name)}</strong>,</p>
      <p>Please confirm that you have received the following device:</p>
      <table>
        <tr><th>Model</th><td>${esc(assignment.device.model)}</td></tr>
        <tr><th>Serial</th><td><code>${esc(assignment.device.serial)}</code></td></tr>
      </table>
      <form method="POST" action="">
        <button type="submit">I confirm receipt of this device</button>
      </form>
    `;

    return reply.type('text/html').send(buildPage('Confirm receipt', html));
  });

  /**
   * POST /api/v1/assignments/:token/ack
   *
   * Public — no session auth. Marks the assignment as acknowledged.
   * Idempotent: safe to submit more than once.
   */
  fastify.post('/assignments/:token/ack', async (request, reply) => {
    const { token } = request.params as { token: string };

    const assignment = await fastify.prisma.deviceAssignment.findUnique({
      where: { acknowledgeToken: token },
      include: {
        device: { select: { model: true, serial: true } },
        employee: { select: { name: true } },
      },
    });

    if (!assignment) {
      return reply
        .status(404)
        .type('text/html')
        .send(buildPage('Link not found', '<h1>Link not found</h1><p>This acknowledgment link is invalid.</p>'));
    }

    if (assignment.returnedAt) {
      return reply
        .type('text/html')
        .send(buildPage('Device returned', '<h1>Device already returned</h1><p>No action needed.</p>'));
    }

    if (
      assignment.acknowledgeExpiresAt &&
      assignment.acknowledgeExpiresAt < new Date()
    ) {
      return reply
        .status(410)
        .type('text/html')
        .send(buildPage('Link expired', '<h1>Link expired</h1><p>This acknowledgment link has expired. Please contact IT.</p>'));
    }

    // Idempotent — only update if not yet acknowledged
    if (!assignment.acknowledgedAt) {
      await fastify.prisma.deviceAssignment.update({
        where: { id: assignment.id },
        data: { acknowledgedAt: new Date() },
      });
    }

    const html = `
      <h1 class="ok">✓ Receipt confirmed</h1>
      <p>Hi <strong>${esc(assignment.employee.name)}</strong>,</p>
      <p>You have acknowledged receipt of <strong>${esc(assignment.device.model)}</strong> (${esc(assignment.device.serial)}).</p>
      <p>Thank you.</p>
    `;

    return reply.type('text/html').send(buildPage('Device Acknowledged', html));
  });
}

// ---------------------------------------------------------------------------
// HTML shell — keeps the response minimal and avoids inline style injection.
// All dynamic values are escaped before insertion.
// ---------------------------------------------------------------------------

function buildPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      max-width: 520px;
      margin: 80px auto;
      padding: 0 16px;
      color: #111;
      line-height: 1.6;
    }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    h1.ok { color: #16a34a; }
    p { color: #444; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    th, td { text-align: left; padding: 8px 12px; border: 1px solid #e2e8f0; }
    th { background: #f8fafc; font-weight: 600; width: 30%; }
    code { font-family: monospace; font-size: 0.9em; }
    button {
      margin-top: 1.5rem;
      padding: 10px 24px;
      background: #4f46e5;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: #4338ca; }
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
}
