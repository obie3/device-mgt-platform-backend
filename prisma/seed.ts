import { PrismaClient, UserRole } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const orgName = process.env.SEED_ORG_NAME ?? 'My Organization';
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'Admin1234!';

  // Upsert org
  const org = await prisma.organization.upsert({
    where: { id: 'seed-org' },
    update: {},
    create: {
      id: 'seed-org',
      name: orgName,
      staleThresholdDays: 14,
    },
  });

  // Upsert admin user
  const passwordHash = await bcrypt.hash(adminPassword, 12);
  const user = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      orgId: org.id,
      name: 'Admin',
      email: adminEmail,
      passwordHash,
      role: UserRole.admin,
    },
  });

  console.log(`Seeded org: ${org.name} (${org.id})`);
  console.log(`Seeded admin: ${user.email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
