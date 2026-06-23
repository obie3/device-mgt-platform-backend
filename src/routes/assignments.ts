import { FastifyInstance } from 'fastify';

export default async function assignmentRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/v1/assignments/:token/ack
   * Public — no session auth. Validates the acknowledgment token and marks
   * the assignment as acknowledged. Idempotent.
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
        .send('<h1>Link not found or already used.</h1>');
    }

    if (assignment.returnedAt) {
      return reply
        .type('text/html')
        .send('<h1>This device has already been returned.</h1>');
    }

    if (
      assignment.acknowledgeExpiresAt &&
      assignment.acknowledgeExpiresAt < new Date()
    ) {
      return reply
        .status(410)
        .type('text/html')
        .send('<h1>This acknowledgment link has expired. Please contact IT.</h1>');
    }

    // Idempotent — only update if not yet acknowledged
    if (!assignment.acknowledgedAt) {
      await fastify.prisma.deviceAssignment.update({
        where: { id: assignment.id },
        data: { acknowledgedAt: new Date() },
      });
    }

    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <title>Device Acknowledged</title>
        <style>
          body { font-family: system-ui, sans-serif; max-width: 480px; margin: 80px auto; text-align: center; color: #111; }
          h1 { color: #16a34a; }
          p { color: #555; }
        </style>
      </head>
      <body>
        <h1>✓ Receipt confirmed</h1>
        <p>Hi <strong>${assignment.employee.name}</strong>,</p>
        <p>You have acknowledged receipt of <strong>${assignment.device.model}</strong> (${assignment.device.serial}).</p>
        <p>Thank you.</p>
      </body>
      </html>
    `;

    return reply.type('text/html').send(html);
  });
}
