import { useCallback, useEffect, useState } from "react";
import {
  queueOfflineInventoryOperation,
  removeSynchronizedOperations,
} from "./utils/offlineInventoryQueue.js";
import {
  RefreshCw,
  ShieldCheck,
  AlertTriangle,
  Users,
  Zap,
  Search,
  Wrench,
  CheckCircle2,
  Clock,
  LoaderCircle,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  Activity,
  Leaf,
  CalendarClock,
  PackageCheck,
  Wifi,
  WifiOff,
  CloudUpload,
} from "lucide-react";

const API_URL = "/api";
const OFFLINE_STORAGE_KEY = "resilio_pending_inventory_operations";

const failureSections = [
  {
    id: "duplicate-token",
    title: "Duplicate Token Failure",
    subtitle: "Queue Management",
    description:
      "Detect a duplicate queue token and assign a unique token to the affected customer.",
    button: "Inject Chaos",
    icon: Users,
    color: "text-violet-700",
    bg: "bg-violet-50",
  },
  {
    id: "synchronization-failure",
    title: "Queue Status Synchronization Failure",
    subtitle: "Queue Management",
    description:
      "Detect outdated customer queue statuses and synchronize them with the latest database status.",
    button: "Inject Chaos",
    icon: RefreshCw,
    color: "text-blue-700",
    bg: "bg-blue-50",
  },
  {
    id: "expired-stock",
    title: "Expired Stock Detection & Auto-Recovery",
    subtitle: "Inventory Management",
    description:
      "Detect expired stock batches, remove expired quantities from usable inventory, and verify recovery.",
    button: "Inject Chaos",
    icon: CalendarClock,
    color: "text-orange-700",
    bg: "bg-orange-50",
  },
  {
    id: "offline-inventory-recovery",
    title: "Offline Inventory Recovery",
    subtitle: "Inventory Management",
    description:
      "Check connectivity, run backend inventory recovery, and verify the recovery result.",
    button: "Check & Recover",
    icon: PackageCheck,
    color: "text-emerald-700",
    bg: "bg-emerald-50",
  },
];

const workflowSteps = [
  { key: "injected", title: "Failure Injected", icon: Zap },
  { key: "detected", title: "Failure Detected", icon: Search },
  { key: "recovering", title: "Recovery in Progress", icon: Wrench },
  { key: "resolved", title: "Resolved Successfully", icon: CheckCircle2 },
];

function stageTitle(stage) {
  const titles = {
    injecting: "Starting Test",
    started: "Starting Recovery",
    checking_connection: "Checking Connection",
    connection_restored: "Connection Restored",
    injected: "Failure Injected",
    detecting: "Detecting Failure",
    detected: "Failure Detected",
    recovery_started: "Recovery in Progress",
    recovering: "Recovery in Progress",
    recovery_in_progress: "Recovery in Progress",
    recovered: "Recovery Verified",
    resolved: "Resolved Successfully",
    cleanup: "Cleaning Up Test Data",
    cleanup_started: "Cleaning Up Test Data",
    cleanup_completed: "Cleanup Completed",
    notification: "Notification",
    customer_notified: "Customer Notified",
    recovery_failed: "Recovery Failed",
    replacement_assigned: "Replacement Token Assigned",
    verification_started: "Verification in Progress",
    verification_passed: "Verification Passed",
    verification_failed: "Verification Failed",
    inventory_found: "Inventory Found",
    inventory_recalculation: "Recalculating Inventory",
    inventory_updated: "Inventory Updated",
  };

  return titles[stage] || "System Activity";
}

function formatTime(timestamp) {
  if (!timestamp) return new Date().toLocaleTimeString();

  const date = new Date(timestamp);

  return Number.isNaN(date.getTime())
    ? new Date().toLocaleTimeString()
    : date.toLocaleTimeString();
}

function normalizeEvent(event) {
  return {
    ...event,
    key: event.stage || event.key,
    title: event.title || stageTitle(event.stage || event.key),
    description: event.message || event.description || "",
    time: event.time || formatTime(event.timestamp),
  };
}

function readPendingOperations() {
  try {
    const value = JSON.parse(
      localStorage.getItem(OFFLINE_STORAGE_KEY) || "[]"
    );

    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/*
 * Reads either an SSE response or an ordinary JSON response.
 * Failures 1–3 and the Failure 4 recovery endpoint use SSE.
 */
async function readRecoveryResponse(response, onProgress) {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("text/event-stream") && response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";
    let finalResult = null;

    const processMessage = (message) => {
      const dataLines = message
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"));

      if (!dataLines.length) return;

      try {
        const payload = JSON.parse(
          dataLines.map((line) => line.slice(5).trim()).join("\n")
        );

        if (payload.type === "progress" && payload.event) {
          onProgress?.(payload.event);
        }

        if (payload.type === "result") {
          finalResult = payload.result;
        }
      } catch (error) {
        console.error("Unable to parse recovery event:", error);
      }
    };

    while (true) {
      const { value, done } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const messages = buffer.split(/\r?\n\r?\n/);
      buffer = messages.pop() || "";

      messages.forEach(processMessage);
    }

    buffer += decoder.decode();

    if (buffer.trim()) processMessage(buffer);

    if (!response.ok) {
      throw new Error(
        finalResult?.message || `Request failed (${response.status}).`
      );
    }

    if (!finalResult) {
      throw new Error("The server did not return a final recovery result.");
    }

    return finalResult;
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      payload.message || `Request failed (${response.status}).`
    );
  }

  return payload.result || payload;
}

function CustomerDetails({ event }) {
  const customerA = event.customers?.customerA || event.customerA;
  const customerB = event.customers?.customerB || event.customerB;

  if (!customerA && !customerB) return null;

  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      {[
        { label: "Customer A", customer: customerA },
        { label: "Customer B", customer: customerB },
      ]
        .filter((item) => item.customer)
        .map(({ label, customer }) => (
          <div
            key={label}
            className="rounded-xl border border-[#e5e9df] bg-white p-3.5"
          >
            <p className="text-xs font-bold uppercase tracking-wide text-[#64816b]">
              {label}
            </p>

            <p className="mt-2 text-sm font-semibold text-[#244638]">
              {customer.name || customer.customerName || label}
            </p>

            {customer.mobileNumber && (
              <p className="mt-1 text-xs text-[#718078]">
                Mobile: {customer.mobileNumber}
              </p>
            )}

            <p className="mt-1 text-xs text-[#718078]">
              Token:{" "}
              <span className="font-bold text-[#244638]">
                {customer.token || customer.tokenNumber || "Not provided"}
              </span>
            </p>

            {customer.status && (
              <p className="mt-2 text-xs leading-5 text-[#718078]">
                Status: {customer.status}
              </p>
            )}
          </div>
        ))}
    </div>
  );
}

function EventDetailsTable({ event }) {
  const excludedKeys = [
    "stage",
    "key",
    "title",
    "message",
    "description",
    "timestamp",
    "time",
    "customers",
    "batches",
  ];

  const details = Object.entries(event).filter(
    ([key, value]) =>
      !excludedKeys.includes(key) &&
      value !== undefined &&
      value !== null &&
      typeof value !== "object"
  );

  const batches = Array.isArray(event.batches) ? event.batches : [];

  const formatLabel = (key) =>
    key
      .replace(/([A-Z])/g, " $1")
      .replace(/^./, (char) => char.toUpperCase());

  const formatValue = (value) => {
    if (typeof value === "boolean") return value ? "Yes" : "No";

    if (
      typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T/.test(value)
    ) {
      return new Date(value).toLocaleString();
    }

    return String(value);
  };

  if (!details.length && !batches.length) return null;

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-[#e5e9df] bg-white">
      {details.length > 0 && (
        <>
          <div className="border-b border-[#e5e9df] bg-[#f5f8f1] px-4 py-3">
            <h6 className="text-xs font-bold uppercase tracking-wide text-[#47754e]">
              Step Details
            </h6>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <tbody>
                {details.map(([key, value]) => (
                  <tr
                    key={key}
                    className="border-b border-[#edf0e9] last:border-0"
                  >
                    <th className="w-2/5 px-4 py-3 font-semibold text-[#536359]">
                      {formatLabel(key)}
                    </th>

                    <td className="break-words px-4 py-3 text-[#244638]">
                      {formatValue(value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {batches.length > 0 && (
        <>
          <div className="border-t border-[#e5e9df] bg-[#f5f8f1] px-4 py-3">
            <h6 className="text-xs font-bold uppercase tracking-wide text-[#47754e]">
              Affected Stock Batches
            </h6>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#fafbf8] text-[#536359]">
                <tr>
                  <th className="px-3 py-3">Batch Code</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3">Expiry Date</th>
                  <th className="px-3 py-3">Remaining Qty</th>
                  <th className="px-3 py-3">Expired Qty</th>
                </tr>
              </thead>

              <tbody>
                {batches.map((batch, index) => (
                  <tr
                    key={batch.batchCode || index}
                    className="border-t border-[#edf0e9]"
                  >
                    <td className="px-3 py-3 font-semibold text-[#244638]">
                      {batch.batchCode || "—"}
                    </td>

                    <td className="px-3 py-3">{batch.status || "—"}</td>

                    <td className="px-3 py-3 text-[#536359]">
                      {batch.expiryDate
                        ? new Date(batch.expiryDate).toLocaleDateString()
                        : "Not recorded"}
                    </td>

                    <td className="px-3 py-3 text-[#536359]">
                      {batch.remainingQuantity ??
                        batch.quantityRemaining ??
                        "—"}
                    </td>

                    <td className="px-3 py-3 text-[#536359]">
                      {batch.expiredQuantity ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function RecoverySummaryTable({ summary }) {
  if (!summary) return null;

  const rows = [
    ["Failure Injected", summary.failureInjected],
    ["Failure Detected", summary.failureDetected],
    ["Automatic Recovery", summary.recovered],
    ["Verification Passed", summary.verificationPassed],
    ["Cleanup Completed", summary.cleanupCompleted],
    ["Batches Recovered", summary.batchesRecovered],
    ["Temporary Batch Removed", summary.temporaryBatchRemoved],
    ["Pending Operations", summary.pendingOperations],
    ["Operations Synchronized", summary.synchronizedOperations],
    ["Database Connected", summary.databaseConnected],
    ["Stock Mismatch Detected", summary.mismatchDetected],
    ["Recovery Verified", summary.recoveryVerified],
  ].filter(([, value]) => value !== undefined && value !== null);

  if (!rows.length) return null;

  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-[#dce8d7] bg-white">
      <div className="border-b border-[#dce8d7] bg-[#f1f6ed] px-4 py-3">
        <h6 className="text-sm font-bold text-[#244638]">
          Recovery Summary
        </h6>

        <p className="mt-1 text-xs text-[#718078]">
          Results reported by the backend recovery process
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-[#fafbf8] text-[#536359]">
            <tr>
              <th className="px-4 py-3">Recovery Check</th>
              <th className="px-4 py-3">Result</th>
            </tr>
          </thead>

          <tbody>
            {rows.map(([label, value]) => (
              <tr key={label} className="border-t border-[#e5e9df]">
                <td className="px-4 py-3 font-medium text-[#536359]">
                  {label}
                </td>

                <td className="px-4 py-3 font-semibold text-[#244638]">
                  {typeof value === "boolean"
                    ? value
                      ? "Successful"
                      : "Not completed"
                    : value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function VerificationTable({ section, verification, summary }) {
  if (!verification && !summary) return null;

  let rows = [];

  if (section.id === "expired-stock") {
    rows = [
      [
        "No Expired Stock Remaining",
        verification?.noExpiredStockRemaining,
      ],
      ["Batches Recovered", summary?.batchesRecovered],
      ["Temporary Batch Removed", summary?.temporaryBatchRemoved],
    ];
  } else if (section.id === "offline-inventory-recovery") {
    rows = [
      ["Browser Online", verification?.browserOnline],
      ["Backend Available", verification?.backendAvailable],
      ["Database Connected", verification?.databaseConnected],
      [
        "Stock Quantity Matches Batches",
        verification?.quantityMatchesBatches,
      ],
      ["Recovery Verified", verification?.recoveryVerified],
    ];
  } else if (section.id === "synchronization-failure") {
    rows = [
      ["Status Mismatch Detected", verification?.mismatchDetected],
      ["Status Synchronized", verification?.synchronized],
      ["Test Cleanup", verification?.cleanupSucceeded],
    ];
  } else {
    rows = [
      ["Duplicate Rejected", verification?.duplicateRejected],
      ["Unique Tokens", verification?.tokensAreDifferent],
      ["Test Cleanup", verification?.cleanupSucceeded],
    ];
  }

  rows = rows.filter(([, value]) => value !== undefined && value !== null);

  if (!rows.length) return null;

  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-[#e5e9df] bg-white">
      <div className="border-b border-[#e5e9df] bg-[#f5f8f1] px-4 py-3">
        <h6 className="text-sm font-bold text-[#244638]">
          Verification Results
        </h6>
      </div>

      <table className="w-full text-left text-sm">
        <tbody>
          {rows.map(([label, value]) => (
            <tr
              key={label}
              className="border-t border-[#edf0e9] first:border-0"
            >
              <td className="px-4 py-3 text-[#536359]">{label}</td>

              <td className="px-4 py-3 font-semibold text-[#244638]">
                {typeof value === "boolean"
                  ? value
                    ? "Verified"
                    : "Not verified"
                  : value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* Failures 1 and 2: detailed queue/customer result design */
function QueueFailureResults({
  section,
  result,
  running,
  onReset,
}) {
  const finalResult = result?.finalResult;

  return (
    <>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h4 className="font-bold text-[#244638]">
            Failure &amp; Recovery Workflow
          </h4>

          <p className="mt-1 text-sm text-[#849087]">
            Review the queue failure, customer details, and recovery outcome.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {result?.completed ? (
            <span className="rounded-full bg-green-100 px-3 py-1.5 text-xs font-semibold text-green-800">
              Resolved
            </span>
          ) : running ? (
            <span className="rounded-full bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-800">
              In progress
            </span>
          ) : result?.currentStage === "recovery_failed" ? (
            <span className="rounded-full bg-red-100 px-3 py-1.5 text-xs font-semibold text-red-800">
              Failed
            </span>
          ) : (
            <span className="rounded-full bg-[#edf5e9] px-3 py-1.5 text-xs font-semibold text-[#4c7654]">
              Ready to test
            </span>
          )}

          {result && !running && (
            <button
              type="button"
              onClick={onReset}
              className="inline-flex items-center gap-1.5 rounded-xl border border-[#dfe7dc] bg-white px-3 py-2 text-xs font-semibold text-[#536359] hover:bg-[#f1f6ed]"
            >
              <RotateCcw size={14} />
              Reset view
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {workflowSteps.map((step, index) => {
          const StepIcon = step.icon;
          const keys = (result?.events || []).map((event) => event.key);

          const complete =
            step.key === "injected"
              ? keys.includes("injected")
              : step.key === "detected"
                ? keys.includes("detected")
                : step.key === "recovering"
                  ? keys.some((key) =>
                      [
                        "recovery_started",
                        "recovering",
                        "recovered",
                      ].includes(key)
                    )
                  : Boolean(result?.completed);

          const active =
            running &&
            (step.key === "injected"
              ? ["injecting", "injected"].includes(result?.currentStage)
              : step.key === "detected"
                ? result?.currentStage === "detected"
                : step.key === "recovering"
                  ? ["recovery_started", "recovering"].includes(
                      result?.currentStage
                    )
                  : false);

          const recentEvent = [...(result?.events || [])]
            .reverse()
            .find((event) => {
              if (step.key === "injected") {
                return ["injecting", "injected"].includes(event.key);
              }

              if (step.key === "detected") {
                return event.key === "detected";
              }

              if (step.key === "recovering") {
                return [
                  "recovery_started",
                  "recovering",
                  "recovered",
                  "replacement_assigned",
                ].includes(event.key);
              }

              return ["recovered", "resolved"].includes(event.key);
            });

          return (
            <div
              key={step.key}
              className={`rounded-2xl border p-4 ${
                complete
                  ? "border-green-200 bg-white"
                  : active
                    ? "border-amber-300 bg-white"
                    : "border-[#e5e9df] bg-white"
              }`}
            >
              <div className="mb-4 flex items-center justify-between">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#f1f6ed] text-[#63866a]">
                  {active ? (
                    <LoaderCircle size={19} className="animate-spin" />
                  ) : (
                    <StepIcon size={19} />
                  )}
                </div>

                <span className="text-xs font-semibold text-[#a0aaa0]">
                  0{index + 1}
                </span>

                {complete && (
                  <CheckCircle2 size={17} className="text-green-600" />
                )}
              </div>

              <h5 className="text-sm font-bold text-[#244638]">
                {step.title}
              </h5>

              <p className="mt-2 text-xs leading-5 text-[#718078]">
                {recentEvent?.description || step.title}
              </p>

              {recentEvent?.time && (
                <p className="mt-3 text-[11px] text-[#89958c]">
                  <Clock size={12} className="mr-1 inline" />
                  {recentEvent.time}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-5 rounded-2xl border border-[#e5e9df] bg-white p-4 sm:p-5">
        <div className="mb-5 flex items-center gap-2">
          <div className="rounded-lg bg-[#e0efdd] p-2 text-[#42734c]">
            <Activity size={18} />
          </div>

          <div>
            <h5 className="font-bold text-[#244638]">
              Recovery Activity Log
            </h5>

            <p className="mt-0.5 text-xs text-[#89958c]">
              Queue events, customer details, and recovery progress
            </p>
          </div>
        </div>

        {!result?.events?.length ? (
          <p className="rounded-xl bg-[#fcfdf9] p-4 text-sm text-[#849087]">
            Click Inject Chaos to display the queue recovery activity.
          </p>
        ) : (
          <div className="space-y-4">
            {result.events.map((event, index) => {
              const failureEvent = ["injected", "detected"].includes(
                event.key
              );

              return (
                <div
                  key={`${event.key}-${index}`}
                  className={`flex gap-3 rounded-xl p-3 ${
                    failureEvent ? "border border-red-200 bg-red-50" : ""
                  }`}
                >
                  <div
                    className={`mt-2 h-2.5 w-2.5 shrink-0 rounded-full ${
                      failureEvent
                        ? "bg-red-400"
                        : event.key === "recovery_failed"
                          ? "bg-red-500"
                          : "bg-[#6b9b78]"
                    }`}
                  />

                  <div className="min-w-0 flex-1 pb-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p
                        className={`text-sm font-bold ${
                          failureEvent ? "text-red-800" : "text-[#244638]"
                        }`}
                      >
                        {event.title}
                      </p>

                      <span className="text-[11px] text-[#89958c]">
                        {event.time}
                      </span>
                    </div>

                    <p className="mt-1 text-sm leading-6 text-[#718078]">
                      {event.description}
                    </p>

                    <EventDetailsTable event={event} />
                    <CustomerDetails event={event} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {finalResult && (
        <div
          className={`mt-5 rounded-2xl border p-5 ${
            finalResult.success
              ? "border-green-200 bg-green-50"
              : "border-red-200 bg-red-50"
          }`}
        >
          <div className="flex items-start gap-3">
            {finalResult.success ? (
              <CheckCircle2
                size={22}
                className="mt-0.5 shrink-0 text-green-700"
              />
            ) : (
              <AlertTriangle
                size={22}
                className="mt-0.5 shrink-0 text-red-700"
              />
            )}

            <div className="min-w-0 flex-1">
              <h5 className="font-bold text-[#244638]">
                {finalResult.success
                  ? "Self-Healing Test Completed"
                  : "Self-Healing Test Failed"}
              </h5>

              <p className="mt-1 text-sm leading-6 text-[#718078]">
                {finalResult.message || "The server returned the final result."}
              </p>

              <VerificationTable
                section={section}
                verification={finalResult.verification}
              />

              {section.id === "synchronization-failure" &&
                finalResult.testResults && (
                  <div className="mt-4 rounded-xl border border-[#e5e9df] bg-white p-4">
                    <h6 className="text-sm font-bold text-[#244638]">
                      Queue Status Verification
                    </h6>

                    <p className="mt-1 text-xs text-[#718078]">
                      Comparing the simulated outdated status with the
                      corrected database status.
                    </p>

                    <div className="mt-3 grid gap-3 sm:grid-cols-3">
                      <div className="rounded-lg bg-red-50 p-3">
                        <p className="text-xs text-red-700">Before Recovery</p>
                        <p className="mt-1 font-bold text-red-800">
                          {finalResult.testResults.staleStatus || "Unknown"}
                        </p>
                      </div>

                      <div className="rounded-lg bg-[#f1f6ed] p-3">
                        <p className="text-xs text-[#47754e]">
                          Database Status
                        </p>
                        <p className="mt-1 font-bold text-[#244638]">
                          {finalResult.testResults.databaseStatus ||
                            finalResult.testResults.actualStatus ||
                            finalResult.testResults.correctedStatus ||
                            "Unknown"}
                        </p>
                      </div>

                      <div className="rounded-lg bg-green-50 p-3">
                        <p className="text-xs text-green-700">After Recovery</p>
                        <p className="mt-1 font-bold text-green-800">
                          {finalResult.testResults.customerA?.status ||
                            finalResult.testResults.correctedStatus ||
                            "Unknown"}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

              {finalResult.testResults && (
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  {[
                    {
                      label: "Customer A",
                      customer: finalResult.testResults.customerA,
                    },
                    {
                      label: "Customer B",
                      customer: finalResult.testResults.customerB,
                    },
                  ]
                    .filter((item) => item.customer)
                    .map(({ label, customer }) => (
                      <div
                        key={label}
                        className="rounded-xl border border-[#e5e9df] bg-white p-4"
                      >
                        <p className="text-xs font-semibold uppercase tracking-wide text-[#64816b]">
                          {label}
                        </p>

                        <p className="mt-2 text-sm font-semibold text-[#244638]">
                          {customer.name || label}
                        </p>

                        {customer.mobileNumber && (
                          <p className="mt-1 text-xs text-[#718078]">
                            Mobile: {customer.mobileNumber}
                          </p>
                        )}

                        <p className="mt-1 text-xs text-[#718078]">
                          Token:{" "}
                          <span className="font-bold text-[#244638]">
                            {customer.token ||
                              customer.tokenNumber ||
                              "Not provided"}
                          </span>
                        </p>

                        {customer.status && (
                          <p className="mt-1 text-xs text-[#718078]">
                            Status: {customer.status}
                          </p>
                        )}
                      </div>
                    ))}
                </div>
              )}

              {finalResult.durationMs != null && (
                <p className="mt-3 text-xs text-[#718078]">
                  Recovery duration:{" "}
                  {(finalResult.durationMs / 1000).toFixed(2)} seconds
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* Failures 3 and 4: newer inventory recovery design */
function InventoryFailureResults({
  section,
  result,
  running,
  onReset,
}) {
  const finalResult = result?.finalResult;

  return (
    <>
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h4 className="font-bold text-[#244638]">
            Failure &amp; Recovery Workflow
          </h4>

          <p className="mt-1 text-sm text-[#849087]">
            Follow detection, automatic repair, and verification.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {result?.completed ? (
            <span className="rounded-full bg-green-100 px-3 py-1.5 text-xs font-semibold text-green-800">
              Resolved
            </span>
          ) : running ? (
            <span className="rounded-full bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-800">
              In progress
            </span>
          ) : result?.currentStage === "recovery_failed" ? (
            <span className="rounded-full bg-red-100 px-3 py-1.5 text-xs font-semibold text-red-800">
              Failed
            </span>
          ) : (
            <span className="rounded-full bg-[#edf5e9] px-3 py-1.5 text-xs font-semibold text-[#4c7654]">
              Ready to test
            </span>
          )}

          {result && !running && (
            <button
              type="button"
              onClick={onReset}
              className="inline-flex items-center gap-1.5 rounded-xl border border-[#dfe7dc] bg-white px-3 py-2 text-xs font-semibold hover:bg-[#f1f6ed]"
            >
              <RotateCcw size={14} />
              Reset view
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {workflowSteps.map((step, index) => {
          const StepIcon = step.icon;
          const keys = (result?.events || []).map((event) => event.key);

          const complete =
            step.key === "injected"
              ? keys.includes("injected")
              : step.key === "detected"
                ? keys.includes("detected")
                : step.key === "recovering"
                  ? keys.some((key) =>
                      [
                        "recovery_started",
                        "recovering",
                        "recovered",
                        "inventory_updated",
                        "verification_passed",
                      ].includes(key)
                    )
                  : Boolean(result?.completed);

          const active =
            running &&
            (step.key === "injected"
              ? ["injecting", "started", "injected"].includes(
                  result?.currentStage
                )
              : step.key === "detected"
                ? ["detecting", "detected"].includes(result?.currentStage)
                : step.key === "recovering"
                  ? [
                      "recovery_started",
                      "recovering",
                      "inventory_recalculation",
                      "inventory_updated",
                      "connection_restored",
                      "checking_connection",
                    ].includes(result?.currentStage)
                  : false);

          const recentEvent = [...(result?.events || [])]
            .reverse()
            .find((event) => {
              if (step.key === "injected") {
                return ["injecting", "started", "injected"].includes(
                  event.key
                );
              }

              if (step.key === "detected") {
                return ["detecting", "detected"].includes(event.key);
              }

              if (step.key === "recovering") {
                return [
                  "recovery_started",
                  "recovering",
                  "recovered",
                  "inventory_recalculation",
                  "inventory_updated",
                  "connection_restored",
                  "verification_started",
                  "verification_passed",
                ].includes(event.key);
              }

              return [
                "recovered",
                "resolved",
                "verification_passed",
                "cleanup_completed",
              ].includes(event.key);
            });

          return (
            <div
              key={step.key}
              className={`rounded-2xl border p-4 transition ${
                complete
                  ? "border-green-200 bg-white"
                  : active
                    ? "border-amber-300 bg-white ring-2 ring-amber-50"
                    : "border-[#e5e9df] bg-white"
              }`}
            >
              <div className="mb-4 flex items-center justify-between">
                <div
                  className={`flex h-10 w-10 items-center justify-center rounded-xl ${
                    complete
                      ? "bg-green-100 text-green-700"
                      : active
                        ? "bg-amber-100 text-amber-700"
                        : "bg-[#f1f6ed] text-[#63866a]"
                  }`}
                >
                  {active ? (
                    <LoaderCircle size={19} className="animate-spin" />
                  ) : (
                    <StepIcon size={19} />
                  )}
                </div>

                <span className="text-xs font-semibold text-[#a0aaa0]">
                  0{index + 1}
                </span>

                {complete && (
                  <CheckCircle2 size={17} className="text-green-600" />
                )}
              </div>

              <h5 className="text-sm font-bold text-[#244638]">
                {step.title}
              </h5>

              <p className="mt-2 text-xs leading-5 text-[#718078]">
                {recentEvent?.description ||
                  (section.id === "offline-inventory-recovery"
                    ? "The system will report this recovery stage when it occurs."
                    : step.title)}
              </p>

              {recentEvent?.time && (
                <p className="mt-3 text-[11px] text-[#89958c]">
                  <Clock size={12} className="mr-1 inline" />
                  {recentEvent.time}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-5 rounded-2xl border border-[#e5e9df] bg-white p-4 sm:p-5">
        <div className="mb-5 flex items-center gap-2">
          <div className="rounded-lg bg-[#e0efdd] p-2 text-[#42734c]">
            <Activity size={18} />
          </div>

          <div>
            <h5 className="font-bold text-[#244638]">Recovery Activity Log</h5>

            <p className="mt-0.5 text-xs text-[#89958c]">
              Inventory detection, recovery, and verification events
            </p>
          </div>
        </div>

        {!result?.events?.length ? (
          <p className="rounded-xl bg-[#fcfdf9] p-4 text-sm text-[#849087]">
            Run the test to display recovery activity here.
          </p>
        ) : (
          <div className="space-y-4">
            {result.events.map((event, index) => {
              const failureEvent = ["injected", "detected"].includes(
                event.key
              );

              return (
                <div
                  key={`${event.key}-${index}`}
                  className={`flex gap-3 rounded-xl p-3 ${
                    failureEvent ? "border border-red-200 bg-red-50" : ""
                  }`}
                >
                  <div
                    className={`mt-2 h-2.5 w-2.5 shrink-0 rounded-full ${
                      failureEvent
                        ? "bg-red-400"
                        : event.key === "recovery_failed" ||
                            event.key === "verification_failed"
                          ? "bg-red-500"
                          : "bg-[#6b9b78]"
                    }`}
                  />

                  <div className="min-w-0 flex-1 pb-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p
                        className={`text-sm font-bold ${
                          failureEvent ? "text-red-800" : "text-[#244638]"
                        }`}
                      >
                        {event.title}
                      </p>

                      <span className="text-[11px] text-[#89958c]">
                        {event.time}
                      </span>
                    </div>

                    <p className="mt-1 text-sm leading-6 text-[#718078]">
                      {event.description}
                    </p>

                    <EventDetailsTable event={event} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {finalResult && (
        <div
          className={`mt-5 rounded-2xl border p-5 ${
            finalResult.success
              ? "border-green-200 bg-green-50"
              : "border-amber-200 bg-amber-50"
          }`}
        >
          <div className="flex items-start gap-3">
            {finalResult.success ? (
              <CheckCircle2
                size={22}
                className="mt-0.5 shrink-0 text-green-700"
              />
            ) : (
              <AlertTriangle
                size={22}
                className="mt-0.5 shrink-0 text-amber-700"
              />
            )}

            <div className="min-w-0 flex-1">
              <h5 className="font-bold text-[#244638]">
                {finalResult.success
                  ? "Self-Healing Test Completed"
                  : "Recovery Needs Attention"}
              </h5>

              <p className="mt-1 text-sm leading-6 text-[#718078]">
                {finalResult.message ||
                  "The backend returned the final recovery result."}
              </p>

              {section.id === "expired-stock" && (
                <RecoverySummaryTable summary={finalResult.summary} />
              )}

              {section.id === "offline-inventory-recovery" && (
                <RecoverySummaryTable summary={finalResult.summary} />
              )}

              <VerificationTable
                section={section}
                verification={finalResult.verification}
                summary={finalResult.summary}
              />

              {finalResult.durationMs != null && (
                <p className="mt-3 text-xs text-[#718078]">
                  Recovery duration:{" "}
                  {(finalResult.durationMs / 1000).toFixed(2)} seconds
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function SilentInventoryDataCorruptionCard() {
  const [testing, setTesting] = useState(false);
  const [showResult, setShowResult] = useState(false);

  const handleTest = () => {
    if (testing) return;

    setTesting(true);
    setShowResult(false);

    // Show the loading state before displaying the demo result.
    window.setTimeout(() => {
      setTesting(false);
      setShowResult(true);
    }, 1200);
  };

  return (
    <div className="space-y-4">
      <article className="rounded-2xl border border-[#F0D5D9] bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            {/* Warning icon */}
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[#FCE7EB] text-[#B42335]">
              <AlertTriangle size={23} />
            </div>

            <div className="min-w-0 flex-1">
              <h3 className="text-base font-bold text-[#173D35]">
                Silent Inventory Data Corruption
              </h3>

              <p className="mt-1.5 max-w-2xl text-sm leading-6 text-[#78877C]">
                Demonstrate a hidden inventory-consistency problem that can
                pass basic server and database health checks. This test does
                not modify your database.
              </p>

              {/* Tags */}
              <div className="mt-3 flex flex-wrap gap-2">
                <span className="rounded-full bg-[#FCE7EB] px-3 py-1 text-xs font-semibold text-[#B42335]">
                  Detection Failure Demo
                </span>

                <span className="rounded-full bg-[#DCEBDD] px-3 py-1 text-xs font-semibold text-[#286344]">
                  Inventory Integrity
                </span>
              </div>
            </div>
          </div>

          {/* Test button */}
          <button
            type="button"
            onClick={handleTest}
            disabled={testing}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-[#A61B32] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#86152A] disabled:cursor-not-allowed disabled:opacity-70"
          >
            {testing ? (
              <LoaderCircle size={17} className="animate-spin" />
            ) : (
              <AlertTriangle size={17} />
            )}

            {testing ? "Injecting Failure..." : "Test Detection Failure"}
          </button>
        </div>

        {/* Demo result */}
        {showResult && (
  <div className="mt-5 rounded-xl border border-[#F0D5D9] bg-[#FFF7F8] p-4">
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        <AlertTriangle
          size={20}
          className="mt-0.5 shrink-0 text-[#B42335]"
        />
        <div>
          <h4 className="font-semibold text-[#922033]">
            Detection Failure Demonstrated
          </h4>
          <p className="mt-1 text-sm leading-6 text-[#73565B]">
            Basic health checks passed, but inventory consistency was not
            checked. This demonstrates a potential detection gap.
          </p>
        </div>
      </div>

      <span className="shrink-0 rounded-full bg-[#DCEBDD] px-3 py-1 text-xs font-bold text-[#286344]">
        DEMO COMPLETE
      </span>
    </div>

    <div className="mt-4 space-y-3">
      <div className="rounded-xl bg-white p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="font-semibold text-[#244638]">
            01 · Request Started
          </p>
          <span className="text-xs font-bold text-[#286344]">COMPLETE</span>
        </div>
        <p className="mt-1 text-sm text-[#78877C]">
          Controlled silent-failure demonstration started.
        </p>
      </div>

      <div className="rounded-xl bg-white p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="font-semibold text-[#244638]">
            02 · Failure Detection
          </p>
          <span className="text-xs font-bold text-[#286344]">COMPLETE</span>
        </div>
        <p className="mt-1 text-sm text-[#78877C]">
          Basic health checks passed, but inventory consistency was not checked.
        </p>
      </div>

      <div className="rounded-xl border border-[#F0D5D9] bg-white p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="font-semibold text-[#922033]">
            03 · Recovery Not Triggered
          </p>
          <span className="text-xs font-bold text-[#A61B32]">
            NOT TRIGGERED
          </span>
        </div>
        <p className="mt-1 text-sm text-[#73565B]">
          No inventory-integrity alert was raised, so recovery did not start.
        </p>
      </div>

      <div className="rounded-xl border border-[#F0D5D9] bg-white p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="font-semibold text-[#922033]">
            04 · Recovery Verification
          </p>
          <span className="text-xs font-bold text-[#A61B32]">
            NOT VERIFIED
          </span>
        </div>
        <p className="mt-1 text-sm text-[#73565B]">
          Inventory consistency remains unverified because this demo does not
          perform a live integrity check.
        </p>
      </div>
    </div>

    <div className="mt-4 rounded-xl bg-white p-3">
      <p className="text-sm font-semibold text-[#244638]">
        Database Changes
      </p>
      <p className="mt-1 text-sm text-[#78877C]">
        None. This is a frontend-only demonstration; no database integrity
        check was performed.
      </p>
    </div>
  </div>
)}
      </article>
    </div>
  );
}

export default function SelfHealingPage() {
  const [expandedId, setExpandedId] = useState(null);
  const [runningId, setRunningId] = useState(null);
  const [results, setResults] = useState({});
  const [errors, setErrors] = useState({});
  const [browserOnline, setBrowserOnline] = useState(navigator.onLine);
  const [pendingCount, setPendingCount] = useState(0);

  const refreshPendingCount = useCallback(() => {
    setPendingCount(readPendingOperations().length);
  }, []);

 useEffect(() => {
    const handleOnline = () => setBrowserOnline(true);
    const handleOffline = () => setBrowserOnline(false);
    const queueUpdated = () => refreshPendingCount();

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    window.addEventListener(
        "resilio-offline-queue-updated",
        queueUpdated
    );

    refreshPendingCount();

    return () => {
        window.removeEventListener("online", handleOnline);
        window.removeEventListener("offline", handleOffline);

        window.removeEventListener(
            "resilio-offline-queue-updated",
            queueUpdated
        );
    };
}, [refreshPendingCount]);

  function appendEvent(id, event) {
    const normalized = normalizeEvent(event);

    setResults((previous) => {
      const current = previous[id] || {};
      const events = current.events || [];
      const last = events[events.length - 1];

      // Avoid a duplicate when the same progress event is received twice.
      if (
        last &&
        last.key === normalized.key &&
        last.description === normalized.description &&
        last.time === normalized.time
      ) {
        return previous;
      }

      return {
        ...previous,
        [id]: {
          ...current,
          currentStage: normalized.key,
          events: [...events, normalized],
        },
      };
    });
  }

  async function runSelfHealingTest(id, endpoint, failureType) {
    setExpandedId(id);
    setRunningId(id);
    setErrors((previous) => ({ ...previous, [id]: "" }));

    setResults((previous) => ({
      ...previous,
      [id]: {
        currentStage: "injecting",
        completed: false,
        events: [
          {
            key: "injecting",
            title: "Starting Test",
            description: `Starting ${failureType} test.`,
            time: new Date().toLocaleTimeString(),
          },
        ],
      },
    }));

    try {
      const response = await fetch(`${API_URL}${endpoint}`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream, application/json",
        },
        body: JSON.stringify({ failureType }),
      });

      const finalResult = await readRecoveryResponse(response, (event) => {
        appendEvent(id, event);
      });

      const events = Array.isArray(finalResult.timeline)
        ? finalResult.timeline.map(normalizeEvent)
        : [];

      setResults((previous) => ({
        ...previous,
        [id]: {
          ...(previous[id] || {}),
          currentStage: finalResult.success ? "resolved" : "recovery_failed",
          events: events.length ? events : previous[id]?.events || [],
          completed: Boolean(finalResult.success),
          finalResult,
        },
      }));

      if (!finalResult.success) {
        setErrors((previous) => ({
          ...previous,
          [id]:
            finalResult.message ||
            "The self-healing test did not complete successfully.",
        }));
      }
    } catch (error) {
      setErrors((previous) => ({
        ...previous,
        [id]: error.message || "Unable to run the test.",
      }));

      setResults((previous) => ({
        ...previous,
        [id]: {
          ...(previous[id] || {}),
          currentStage: "recovery_failed",
          completed: false,
        },
      }));
    } finally {
      setRunningId(null);
      refreshPendingCount();
    }
  }

  async function runOfflineRecovery(section) {
    setExpandedId(section.id);
    setRunningId(section.id);
    setErrors((previous) => ({ ...previous, [section.id]: "" }));

    const localPending = readPendingOperations();
    setPendingCount(localPending.length);

    const initialEvents = [];

    const addInitialEvent = (stage, message, details = {}) => {
      const event = normalizeEvent({
        stage,
        message,
        timestamp: new Date().toISOString(),
        ...details,
      });

      initialEvents.push(event);

      setResults((previous) => ({
        ...previous,
        [section.id]: {
          ...(previous[section.id] || {}),
          currentStage: stage,
          completed: false,
          events: [...initialEvents],
        },
      }));
    };

    try {
      addInitialEvent(
        "started",
        "Starting offline inventory recovery check.",
        {
          browserOnline,
          pendingOperations: localPending.length,
        }
      );

      if (!browserOnline) {
        throw new Error(
          "Your browser is offline. Pending operations remain stored locally; the backend cannot be contacted until the connection returns."
        );
      }

      addInitialEvent(
        "checking_connection",
        "Checking the Resilio backend and MongoDB connection."
      );

      const healthResponse = await fetch(
        `${API_URL}/self-healing/offline-inventory/health`,
        {
          method: "GET",
          credentials: "include",
          headers: { Accept: "application/json" },
        }
      );

      const health = await healthResponse.json().catch(() => ({}));

      if (!healthResponse.ok || health.success === false) {
        throw new Error(
          health.message || "The backend or MongoDB is unavailable."
        );
      }

      addInitialEvent(
        "connection_restored",
        health.message || "The backend health check passed.",
        {
          backendAvailable: Boolean(health.backendAvailable),
          databaseConnected: Boolean(health.databaseConnected),
        }
      );

      /*
       * The provided backend route currently repairs a stock-quantity
       * mismatch. It does not yet replay arbitrary pending local operations.
       */
     const response = await fetch(
    `${API_URL}/self-healing/offline-inventory/recover`,
    {
        method: "POST",
        credentials: "include",
        headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream, application/json",
        },
        body: JSON.stringify({
            pendingOperations: localPending,
        }),
    }
);

      const finalResult = await readRecoveryResponse(response, (event) => {
        appendEvent(section.id, event);
      });

      const remainingOperations = removeSynchronizedOperations(
    finalResult.processedOperationIds || []
);

setPendingCount(remainingOperations.length);

      const backendEvents = Array.isArray(finalResult.timeline)
        ? finalResult.timeline.map(normalizeEvent)
        : [];

      const combinedEvents =
    backendEvents.length > 0 ? backendEvents : initialEvents;

      setResults((previous) => ({
        ...previous,
        [section.id]: {
          ...(previous[section.id] || {}),
          currentStage: finalResult.success ? "resolved" : "recovery_failed",
          events: combinedEvents,
          completed: Boolean(finalResult.success),
          finalResult,
        },
      }));

      if (!finalResult.success) {
        setErrors((previous) => ({
          ...previous,
          [section.id]:
            finalResult.message || "Inventory recovery did not complete.",
        }));
      }

      refreshPendingCount();
    } catch (error) {
      setErrors((previous) => ({
        ...previous,
        [section.id]:
          error.message || "Offline inventory recovery could not complete.",
      }));

      setResults((previous) => ({
        ...previous,
        [section.id]: {
          ...(previous[section.id] || {}),
          currentStage: "recovery_failed",
          events: [...initialEvents],
          completed: false,
        },
      }));
    } finally {
      setRunningId(null);
      refreshPendingCount();
    }
  }

  function runDemo(section) {
    if (runningId) return;

    setExpandedId(section.id);
    setErrors((previous) => ({ ...previous, [section.id]: "" }));

    if (section.id === "duplicate-token") {
      runSelfHealingTest(
        section.id,
        "/self-healing/inject-chaos",
        "duplicate-token"
      );
      return;
    }

    if (section.id === "synchronization-failure") {
      runSelfHealingTest(
        section.id,
        "/self-healing/synchronization-failure",
        "synchronization-failure"
      );
      return;
    }

    if (section.id === "expired-stock") {
      runSelfHealingTest(
        section.id,
        "/self-healing/expired-stock",
        "expired-stock"
      );
      return;
    }

    if (section.id === "offline-inventory-recovery") {
      runOfflineRecovery(section);
    }
  }

  function resetSection(id) {
    if (runningId === id) return;

    setResults((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });

    setErrors((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
  }

  return (
    <div className="space-y-6 text-[#244638]">
      {/* Page header */}
      <section className="flex flex-col justify-between gap-5 rounded-2xl border border-[#dfe8d9] bg-gradient-to-r from-[#e3efdf] via-[#f0f4e9] to-[#fff0e5] p-6 sm:flex-row sm:items-center">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[#64816b]">
            <Leaf size={15} />
            Inventory management
          </div>

          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Self-Healing Monitor
          </h1>

          <p className="mt-2 max-w-xl text-sm leading-6 text-[#6e8073]">
            Monitor failures, observe automatic recovery, and verify that the
            system returns to a healthy state.
          </p>
        </div>

        <div className="flex w-fit items-center gap-2 rounded-xl border border-white/70 bg-white/70 px-4 py-3 text-sm font-semibold">
          {browserOnline ? (
            <Wifi size={17} className="text-green-700" />
          ) : (
            <WifiOff size={17} className="text-red-700" />
          )}

          {browserOnline ? "Browser online" : "Browser offline"}
        </div>
      </section>

      {/* Monitor summary */}
      <section className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-2xl border border-[#e5e9df] bg-white p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-[#718078]">
            Network
          </p>

          <p className="mt-2 text-lg font-bold">
            {browserOnline ? "Connected" : "Offline"}
          </p>
        </div>

        <div className="rounded-2xl border border-[#e5e9df] bg-white p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-[#718078]">
            Pending local operations
          </p>

          <p className="mt-2 text-lg font-bold">{pendingCount}</p>
        </div>

        <div className="rounded-2xl border border-[#e5e9df] bg-white p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-[#718078]">
            Recovery monitor
          </p>

          <p className="mt-2 text-lg font-bold text-[#2f684b]">
            {runningId ? "Working..." : "Ready"}
          </p>
        </div>
      </section>

      <section className="flex gap-4 rounded-2xl border border-[#e5e9df] bg-white p-5 shadow-sm sm:p-6">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#e0efdd] text-[#42734c]">
          <ShieldCheck size={24} />
        </div>

        <div>
          <h2 className="text-lg font-bold text-[#244638]">
            Failure Simulation Center
          </h2>

          <p className="mt-1 max-w-3xl text-sm leading-6 text-[#718078]">
            Select a scenario to see how Resilio detects a failure, recovers
            from it, and verifies the result.
          </p>
        </div>
      </section>

      <div className="space-y-5">
        {failureSections.map((section, index) => {
          const Icon = section.icon;
          const expanded = expandedId === section.id;
          const result = results[section.id];
          const running = runningId === section.id;

          const isQueueFailure =
            section.id === "duplicate-token" ||
            section.id === "synchronization-failure";

          return (
            <section
              key={section.id}
              className={`overflow-hidden rounded-2xl border bg-white shadow-sm transition ${
                expanded
                  ? "border-[#b5cdb0] ring-1 ring-[#dcebd9]"
                  : "border-[#e5e9df]"
              }`}
            >
              <div className="flex flex-col justify-between gap-5 p-5 sm:p-6 lg:flex-row lg:items-center">
                <div className="flex min-w-0 items-start gap-4">
                  <div
                    className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${section.bg} ${section.color}`}
                  >
                    <Icon size={23} />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wider text-[#89958c]">
                        Failure {String(index + 1).padStart(2, "0")}
                      </span>

                      <span
                        className={`rounded-full px-3 py-1 text-xs font-semibold ${section.bg} ${section.color}`}
                      >
                        {section.subtitle}
                      </span>
                    </div>

                    <h3 className="text-lg font-bold text-[#244638]">
                      {section.title}
                    </h3>

                    <p className="mt-1.5 max-w-2xl text-sm leading-6 text-[#718078]">
                      {section.description}
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-3 lg:pl-4">
                  <button
                    type="button"
                    disabled={Boolean(runningId)}
                    onClick={() => runDemo(section)}
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#2f684b] px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[#24553b] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {running ? (
                      <LoaderCircle size={17} className="animate-spin" />
                    ) : section.id === "offline-inventory-recovery" ? (
                      <CloudUpload size={17} />
                    ) : (
                      <Zap size={17} />
                    )}

                    {running ? "Running Test..." : section.button}
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setExpandedId(expanded ? null : section.id)
                    }
                    aria-label={
                      expanded
                        ? `Collapse ${section.title}`
                        : `Expand ${section.title}`
                    }
                    className="rounded-xl border border-[#dfe7dc] bg-white p-3 text-[#47754e] transition hover:bg-[#f1f6ed]"
                  >
                    {expanded ? (
                      <ChevronUp size={19} />
                    ) : (
                      <ChevronDown size={19} />
                    )}
                  </button>
                </div>
              </div>

              {expanded && (
                <div className="border-t border-[#e8ebe2] bg-[#fcfdf9] p-5 sm:p-6">
                  {errors[section.id] && (
                    <div
                      role="alert"
                      className="mb-5 flex gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
                    >
                      <AlertTriangle size={19} className="mt-0.5 shrink-0" />

                      <div>
                        <p className="font-semibold">Test could not finish</p>

                        <p className="mt-1 leading-5">
                          {errors[section.id]}
                        </p>

                        <p className="mt-2 text-xs">
                          Check that the backend is running and you are logged
                          in as an admin.
                        </p>
                      </div>
                    </div>
                  )}

                  {isQueueFailure ? (
                    <QueueFailureResults
                      section={section}
                      result={result}
                      running={running}
                      onReset={() => resetSection(section.id)}
                    />
                  ) : (
                    <InventoryFailureResults
                      section={section}
                      result={result}
                      running={running}
                      onReset={() => resetSection(section.id)}
                    />
                  )}
                </div>
              )}
            </section>
          );


        })}
      </div>

<SilentInventoryDataCorruptionCard />

      {/* <p className="text-xs leading-5 text-[#89958c]">
        Self-healing results are based on backend verification. The browser's
        online status does not by itself prove that MongoDB is reachable or
        that pending offline operations have been synchronized.
      </p> */}
    </div>
  );
}