import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const cmp = await prisma.comparison.findUnique({
    where: { id: 'daaf1d9a-aa6c-4819-835f-b32127992566' },
    select: { status: true, errorMessage: true, updatedAt: true }
  });
  console.log(cmp ? `Status: ${cmp.status}\nError: ${cmp.errorMessage || 'none'}\nUpdated: ${cmp.updatedAt?.toISOString()}` : 'Not found');
}
main().catch(console.error).finally(() => prisma.$disconnect());
