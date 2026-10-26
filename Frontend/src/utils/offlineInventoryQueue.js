const STORAGE_KEY = "resilio_pending_inventory_operations";

export function readPendingInventoryOperations() {
    try {
        const operations = JSON.parse(
            localStorage.getItem(STORAGE_KEY) || "[]"
        );

        return Array.isArray(operations) ? operations : [];
    } catch {
        return [];
    }
}

export function queueOfflineInventoryOperation(type, payload) {
    if (!["stock-in", "stock-out"].includes(type)) {
        throw new Error("Unsupported offline inventory operation.");
    }

    const operations = readPendingInventoryOperations();

    const operationId =
        payload?.operationId ||
        (globalThis.crypto?.randomUUID
            ? globalThis.crypto.randomUUID()
            : `offline-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    const existing = operations.find(
        (operation) => operation.operationId === operationId
    );

    if (existing) {
        return existing;
    }

    const operation = {
        operationId,
        type,
        payload: {
            ...payload,
            operationId,
        },
        queuedAt: new Date().toISOString(),
    };

    operations.push(operation);

    localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(operations)
    );

    window.dispatchEvent(
        new Event("resilio-offline-queue-updated")
    );

    return operation;
}

export function removeSynchronizedOperations(operationIds) {
    const completedIds = new Set(operationIds || []);

    const remaining = readPendingInventoryOperations().filter(
        (operation) => !completedIds.has(operation.operationId)
    );

    localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(remaining)
    );

    window.dispatchEvent(
        new Event("resilio-offline-queue-updated")
    );

    return remaining;
}