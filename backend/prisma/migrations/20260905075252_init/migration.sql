-- CreateTable
CREATE TABLE "Patient" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "patientCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "age" INTEGER NOT NULL,
    "bloodPressureSystolic" INTEGER NOT NULL,
    "bloodPressureDiastolic" INTEGER NOT NULL,
    "heartRate" INTEGER NOT NULL,
    "glucose" INTEGER NOT NULL,
    "diagnosis" TEXT NOT NULL,
    "partitionIndex" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "riskScore" INTEGER,
    "riskLevel" TEXT,
    "backfillStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "lastBackfillVersion" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BackfillJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "status" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "seed" INTEGER NOT NULL,
    "settings" TEXT NOT NULL,
    "totalRecords" INTEGER NOT NULL,
    "partitionCount" INTEGER NOT NULL,
    "eligibleRecords" INTEGER NOT NULL,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "applied" INTEGER NOT NULL DEFAULT 0,
    "noopAlreadyCurrent" INTEGER NOT NULL DEFAULT 0,
    "conflicts" INTEGER NOT NULL DEFAULT 0,
    "reevaluated" INTEGER NOT NULL DEFAULT 0,
    "protectedUpdates" INTEGER NOT NULL DEFAULT 0,
    "staleBlocked" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "currentPartition" INTEGER NOT NULL DEFAULT 0,
    "currentRecordIndex" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "crashedAt" DATETIME,
    "recoveredAt" DATETIME,
    "completedAt" DATETIME,
    "failureReason" TEXT
);

-- CreateTable
CREATE TABLE "Checkpoint" (
    "jobId" TEXT NOT NULL,
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "partitionIndex" INTEGER NOT NULL,
    "recordPosition" INTEGER NOT NULL,
    "processedCount" INTEGER NOT NULL,
    "jobStatus" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Checkpoint_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BackfillJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PendingResult" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "jobId" TEXT NOT NULL,
    "patientId" INTEGER NOT NULL,
    "sourceVersion" INTEGER NOT NULL,
    "computedScore" INTEGER NOT NULL,
    "computedLevel" TEXT NOT NULL,
    "inputSnapshot" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PendingResult_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BackfillJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PendingResult_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ConsiderationLedger" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "jobId" TEXT NOT NULL,
    "patientId" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "sourceVersion" INTEGER NOT NULL,
    "appliedVersion" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "phase" TEXT NOT NULL,
    "reason" TEXT,
    "decidedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConsiderationLedger_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BackfillJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ConsiderationLedger_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WriteLedger" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "jobId" TEXT NOT NULL,
    "patientId" INTEGER NOT NULL,
    "guardVersion" INTEGER NOT NULL,
    "rowVersionAtWrite" INTEGER NOT NULL,
    "applied" BOOLEAN NOT NULL,
    "guarded" BOOLEAN NOT NULL DEFAULT true,
    "wroteSourceFields" BOOLEAN NOT NULL DEFAULT false,
    "scoreWritten" INTEGER,
    "resultingLastBfVer" INTEGER,
    "phase" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WriteLedger_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BackfillJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WriteLedger_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Conflict" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "jobId" TEXT NOT NULL,
    "patientId" INTEGER NOT NULL,
    "sourceVersion" INTEGER NOT NULL,
    "currentVersion" INTEGER NOT NULL,
    "oldScore" INTEGER NOT NULL,
    "newScore" INTEGER,
    "changedFields" TEXT NOT NULL,
    "resolution" TEXT NOT NULL DEFAULT 'PENDING',
    "detectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    CONSTRAINT "Conflict_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "BackfillJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Conflict_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OnlineUpdate" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "patientId" INTEGER NOT NULL,
    "actorType" TEXT NOT NULL,
    "changedFields" TEXT NOT NULL,
    "previousVersion" INTEGER NOT NULL,
    "newVersion" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OnlineUpdate_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EventLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sequence" INTEGER NOT NULL,
    "jobId" TEXT,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "patientCode" TEXT,
    "partitionIndex" INTEGER,
    "payload" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Patient_patientCode_key" ON "Patient"("patientCode");

-- CreateIndex
CREATE INDEX "Patient_partitionIndex_id_idx" ON "Patient"("partitionIndex", "id");

-- CreateIndex
CREATE INDEX "Patient_backfillStatus_idx" ON "Patient"("backfillStatus");

-- CreateIndex
CREATE INDEX "Patient_version_idx" ON "Patient"("version");

-- CreateIndex
CREATE INDEX "BackfillJob_status_idx" ON "BackfillJob"("status");

-- CreateIndex
CREATE INDEX "Checkpoint_jobId_status_idx" ON "Checkpoint"("jobId", "status");

-- CreateIndex
CREATE INDEX "PendingResult_jobId_state_idx" ON "PendingResult"("jobId", "state");

-- CreateIndex
CREATE INDEX "PendingResult_patientId_idx" ON "PendingResult"("patientId");

-- CreateIndex
CREATE INDEX "ConsiderationLedger_jobId_outcome_idx" ON "ConsiderationLedger"("jobId", "outcome");

-- CreateIndex
CREATE UNIQUE INDEX "ConsiderationLedger_jobId_patientId_key" ON "ConsiderationLedger"("jobId", "patientId");

-- CreateIndex
CREATE INDEX "WriteLedger_jobId_patientId_idx" ON "WriteLedger"("jobId", "patientId");

-- CreateIndex
CREATE INDEX "WriteLedger_jobId_applied_idx" ON "WriteLedger"("jobId", "applied");

-- CreateIndex
CREATE INDEX "Conflict_jobId_resolution_idx" ON "Conflict"("jobId", "resolution");

-- CreateIndex
CREATE INDEX "Conflict_patientId_idx" ON "Conflict"("patientId");

-- CreateIndex
CREATE INDEX "OnlineUpdate_patientId_newVersion_idx" ON "OnlineUpdate"("patientId", "newVersion");

-- CreateIndex
CREATE INDEX "OnlineUpdate_createdAt_idx" ON "OnlineUpdate"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "EventLog_sequence_key" ON "EventLog"("sequence");

-- CreateIndex
CREATE INDEX "EventLog_sequence_idx" ON "EventLog"("sequence");

-- CreateIndex
CREATE INDEX "EventLog_type_idx" ON "EventLog"("type");
