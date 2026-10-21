-- CreateEnum
CREATE TYPE "FeeAudience" AS ENUM ('ALL', 'NEW', 'RETURNING');

-- AlterTable
ALTER TABLE "fee_types" ADD COLUMN     "audience" "FeeAudience" NOT NULL DEFAULT 'ALL',
ADD COLUMN     "optional" BOOLEAN NOT NULL DEFAULT false;

