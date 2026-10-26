const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const Queue = require("../datamodels/Queue");
const requireAdmin = require("../middleware/requireAdmin");

const StockBatch = require("../datamodels/StockBatch");
const StockQuantity = require("../datamodels/StockQuantity");
const Ingredient = require("../datamodels/Ingredient");

const StockMovement = require("../datamodels/StockMovement");

const { stockIn } = require("../inventoryLogic/stockInLogic");
const { stockOut } = require("../inventoryLogic/stockOutLogic");


const {
  reconcileIngredient,
} = require("../inventoryLogic/stockReconciliationLogic");
// Health check must appear before requireAdmin middleware.
router.get("/offline-inventory/health", (req, res) => {
    const databaseConnected = mongoose.connection.readyState === 1;

    return res.status(databaseConnected ? 200 : 503).json({
        success: databaseConnected,
        backendAvailable: true,
        databaseConnected,
        message: databaseConnected
            ? "Backend and MongoDB are connected."
            : "Backend is running, but MongoDB is disconnected."
    });
});


// Health check — place before admin protection
router.get("/offline-inventory/health", (req, res) => {
    const databaseConnected = mongoose.connection.readyState === 1;

    return res.status(databaseConnected ? 200 : 503).json({
        success: databaseConnected,
        backendAvailable: true,
        databaseConnected,
        message: databaseConnected
            ? "Backend and MongoDB are connected."
            : "Backend is running, but MongoDB is disconnected."
    });
});


router.use(requireAdmin);



const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sendEvent(res, type, data) {
    if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    }
}

function sendProgress(res, timeline, stage, message, extra = {}) {
    const event = {
        stage,
        message,
        timestamp: new Date().toISOString(),
        ...extra,
    };

    timeline.push(event);
    sendEvent(res, "progress", { event });
}

function beginStream(res) {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
}

async function generateUniqueToken() {
    for (let attempt = 0; attempt < 100; attempt++) {
        const token = `R-${Math.floor(1000 + Math.random() * 9000)}`;
        const exists = await Queue.exists({ tokenNumber: token });

        if (!exists) {
            return token;
        }
    }

    throw new Error("Could not generate a unique test token.");
}

function customerDetails(customer, status) {
    return {
        name: customer.customerName,
        mobileNumber: customer.mobileNumber,
        token: customer.tokenNumber,
        tokenNumber: customer.tokenNumber,
        status,
    };
}

// FAILURE 1: DUPLICATE TOKEN FAILURE
router.post("/inject-chaos", async (req, res) => {
    const timeline = [];
    const testIds = new Set();

    let streamStarted = false;
    let customerA = null;
    let customerB = null;
    let duplicateRejected = false;
    let duplicateError = null;
    let replacementToken = null;

    const stages = {
        failureInjected: false,
        failureDetected: false,
        recoveryCompleted: false,
        customerNotified: false,
        verificationPassed: false,
        cleanupSucceeded: false,
    };

    try {
        beginStream(res);
        streamStarted = true;

        sendProgress(
            res,
            timeline,
            "injecting",
            "Starting the controlled duplicate-token test."
        );

        await wait(400);

        const originalToken = await generateUniqueToken();

        // Step 1: Create Customer A.
        customerA = await Queue.create({
            customerName: "Resilio Test Customer A",
            mobileNumber: "9999900001",
            partySize: 2,
            arrivalType: "onsite",
            tokenNumber: originalToken,
            status: "Waiting",
            estimatedWaitMinutes: 0,
        });

        testIds.add(String(customerA._id));

        const attemptedCustomerB = {
            name: "Resilio Test Customer B",
            mobileNumber: "9999900002",
            token: originalToken,
            tokenNumber: originalToken,
            status: "Duplicate token attempt",
        };

        stages.failureInjected = true;

        sendProgress(
            res,
            timeline,
            "injected",
            "Failure injected: both customers are shown attempting to use the same token.",
            {
                customers: {
                    customerA: customerDetails(
                        customerA,
                        "Original token assigned"
                    ),
                    customerB: attemptedCustomerB,
                },
                tokenNumber: originalToken,
            }
        );

        await wait(700);

        // Step 2: Detect the duplicate-token failure.
        sendProgress(
            res,
            timeline,
            "detected",
            "Checking whether the database rejects Customer B's duplicate token.",
            {
                customers: {
                    customerA: customerDetails(
                        customerA,
                        "Original token assigned"
                    ),
                    customerB: attemptedCustomerB,
                },
            }
        );

        try {
            customerB = await Queue.create({
                customerName: "Resilio Test Customer B",
                mobileNumber: "9999900002",
                partySize: 2,
                arrivalType: "onsite",
                tokenNumber: originalToken,
                status: "Waiting",
                estimatedWaitMinutes: 0,
            });

            testIds.add(String(customerB._id));
        } catch (error) {
            if (error.code === 11000) {
                duplicateRejected = true;
                duplicateError =
                    "The database rejected the duplicate token.";
            } else {
                throw error;
            }
        }

        stages.failureDetected = true;

        sendProgress(
            res,
            timeline,
            "recovery_started",
            duplicateRejected
                ? "Duplicate detected and rejected. Assigning Customer B a replacement token."
                : "The database accepted the duplicate. Repairing Customer B's token.",
            {
                duplicateRejected,
                customers: {
                    customerA: customerDetails(
                        customerA,
                        "Original token retained"
                    ),
                    customerB: attemptedCustomerB,
                },
            }
        );

        await wait(700);

        // Step 3: Recover by assigning a unique token.
        replacementToken = await generateUniqueToken();

        if (customerB) {
            customerB.tokenNumber = replacementToken;
            await customerB.save();
        } else {
            customerB = await Queue.create({
                customerName: "Resilio Test Customer B",
                mobileNumber: "9999900002",
                partySize: 2,
                arrivalType: "onsite",
                tokenNumber: replacementToken,
                status: "Waiting",
                estimatedWaitMinutes: 0,
            });

            testIds.add(String(customerB._id));
        }

        stages.recoveryCompleted = true;

        sendProgress(
            res,
            timeline,
            "replacement_assigned",
            "Recovery action completed: Customer B received a unique replacement token.",
            {
                customers: {
                    customerA: customerDetails(
                        customerA,
                        "Original token retained"
                    ),
                    customerB: customerDetails(
                        customerB,
                        "Replacement token assigned"
                    ),
                },
                originalToken,
                replacementToken,
            }
        );

        await wait(400);

        // Step 4: Show the simulated customer notification AFTER recovery.
        const notification = {
            customerName: customerB.customerName,
            mobileNumber: customerB.mobileNumber,
            oldToken: originalToken,
            newToken: customerB.tokenNumber,
            message: `Your queue token has been updated to ${customerB.tokenNumber}. Please use your new token to track your queue.`,
            type: "in-app",
            status: "demo",
        };

        sendProgress(
            res,
            timeline,
            "customer_notified",
            `Test notification displayed for ${customerB.customerName}: ${notification.message}`,
            { notification }
        );

        stages.customerNotified = true;

        await wait(500);

        // Step 5: Verify both database records.
        sendProgress(
            res,
            timeline,
            "verification_started",
            "Verifying both customer records and checking token uniqueness."
        );

        const savedCustomerA = await Queue.findById(customerA._id).lean();
        const savedCustomerB = await Queue.findById(customerB._id).lean();

        const bothCustomersExist = Boolean(
            savedCustomerA && savedCustomerB
        );

        const tokensAreDifferent = Boolean(
            bothCustomersExist &&
            savedCustomerA.tokenNumber &&
            savedCustomerB.tokenNumber &&
            savedCustomerA.tokenNumber !== savedCustomerB.tokenNumber
        );

        const bothTestCustomersVerified =
            bothCustomersExist && tokensAreDifferent;

        stages.verificationPassed =
            duplicateRejected && bothTestCustomersVerified;

        sendProgress(
            res,
            timeline,
            tokensAreDifferent ? "recovered" : "recovery_failed",
            stages.verificationPassed
                ? "Recovery verified: the database rejected the duplicate and both customers now have different tokens."
                : tokensAreDifferent
                    ? "Tokens are now different, but the complete protection test did not pass. Check whether the database has a unique token index."
                    : "Verification failed: both customer records do not have different tokens.",
            {
                duplicateRejected,
                tokensAreDifferent,
                bothTestCustomersVerified,
                customers: {
                    customerA: savedCustomerA
                        ? customerDetails(savedCustomerA, "Verified")
                        : {
                            name: "Resilio Test Customer A",
                            token: originalToken,
                            status: "Record not found",
                        },
                    customerB: savedCustomerB
                        ? customerDetails(savedCustomerB, "Verified")
                        : {
                            name: "Resilio Test Customer B",
                            token: replacementToken,
                            status: "Record not found",
                        },
                },
            }
        );

        // Step 6: Remove temporary test records.
        sendProgress(
            res,
            timeline,
            "cleanup",
            "Removing temporary test customers."
        );

        await Queue.deleteMany({
            _id: { $in: [...testIds] },
        });

        const remainingTestRecords = await Queue.countDocuments({
            _id: { $in: [...testIds] },
        });

        stages.cleanupSucceeded = remainingTestRecords === 0;

        const success =
            stages.verificationPassed && stages.cleanupSucceeded;

        const result = {
            success,
            recovered: stages.recoveryCompleted && tokensAreDifferent,
            completed: true,
            failureType: "duplicate-token",
            message: success
                ? "Duplicate-token failure detected, recovered, verified, and cleaned up successfully."
                : !duplicateRejected
                    ? "Recovery changed the tokens, but the database accepted a duplicate. Configure a unique index on tokenNumber to pass the full test."
                    : "The test did not pass all recovery, verification, or cleanup checks.",
            durationMs: Date.now() - new Date(
                timeline[0].timestamp
            ).getTime(),
            timeline,
            testResults: {
                customerA: {
                    name: "Resilio Test Customer A",
                    token: originalToken,
                    tokenNumber: originalToken,
                },
                customerB: {
                    name: "Resilio Test Customer B",
                    attemptedToken: originalToken,
                    token: replacementToken,
                    tokenNumber: replacementToken,
                },
                duplicateRejected,
                duplicateError,
                bothTestCustomersVerified,
                notification,
            },
            verification: {
                duplicateRejected,
                bothTestCustomersVerified,
                tokensAreDifferent,
                cleanupSucceeded: stages.cleanupSucceeded,
            },
            stages,
        };

        sendEvent(res, "result", { result });
        res.end();
    } catch (error) {
        console.error("Duplicate-token test failed:", error);

        try {
            if (testIds.size > 0) {
                await Queue.deleteMany({
                    _id: { $in: [...testIds] },
                });

                const remaining = await Queue.countDocuments({
                    _id: { $in: [...testIds] },
                });

                stages.cleanupSucceeded = remaining === 0;
            } else {
                stages.cleanupSucceeded = true;
            }
        } catch (cleanupError) {
            console.error("Test cleanup failed:", cleanupError);
        }

        if (streamStarted && !res.writableEnded) {
            sendProgress(
                res,
                timeline,
                "recovery_failed",
                `Duplicate-token test failed: ${error.message}`
            );

            sendEvent(res, "result", {
                result: {
                    success: false,
                    recovered: false,
                    completed: false,
                    failureType: "duplicate-token",
                    message: error.message,
                    timeline,
                    stages,
                    verification: {
                        duplicateRejected,
                        tokensAreDifferent: false,
                        cleanupSucceeded: stages.cleanupSucceeded,
                    },
                },
            });

            res.end();
        } else if (!res.headersSent) {
            res.status(500).json({
                success: false,
                message: error.message,
            });
        }
    }
});



















/* FAILURE 2: QUEUE STATUS SYNCHRONIZATION FAILURE */

router.post("/synchronization-failure", async (req, res) => {
    const timeline = [];
    const testIds = new Set();
    let streamStarted = false;
    let testQueue = null;
    let token = null;
    let displayedStatus = null;
    let actualStatus = null;
    let mismatchDetected = false;
    let synchronized = false;

    const stages = {
        failureInjected: false,
        failureDetected: false,
        recoveryCompleted: false,
        verificationPassed: false,
        cleanupSucceeded: false,
    };

    const customer = {
        name: "Resilio Sync Test Customer",
        mobileNumber: "9999900003",
    };

    function customerEvent(statusDescription) {
        return {
            customers: {
                customerA: {
                    name: customer.name,
                    mobileNumber: customer.mobileNumber,
                    token,
                    status: statusDescription,
                },
            },
        };
    }

    try {
        beginStream(res);
        streamStarted = true;

        sendProgress(
            res,
            timeline,
            "injecting",
            "Starting the controlled queue status synchronization test."
        );

        await wait(400);

        // Create a temporary test customer in the database.
        token = await generateUniqueToken();

        testQueue = await Queue.create({
            customerName: customer.name,
            mobileNumber: customer.mobileNumber,
            partySize: 2,
            arrivalType: "onsite",
            tokenNumber: token,
            status: "Completed",
            estimatedWaitMinutes: 0,
        });

        testIds.add(String(testQueue._id));

        // Simulate an incorrect displayed status.
        displayedStatus = "Seated";
        actualStatus = testQueue.status;

        stages.failureInjected = true;

        sendProgress(
            res,
            timeline,
            "injected",
            `Failure injected: the displayed status is "${displayedStatus}", while the saved database status is "${actualStatus}".`,
            {
                displayedStatus,
                actualStatus,
                tokenNumber: token,
                ...customerEvent(
                    `Displayed status: ${displayedStatus}. Database status: ${actualStatus}.`
                ),
            }
        );

        await wait(600);

        // Detect the mismatch using the saved database record.
        const savedRecord = await Queue.findById(
            testQueue._id
        ).lean();

        if (!savedRecord) {
            throw new Error(
                "The temporary queue record could not be found."
            );
        }

        actualStatus = savedRecord.status;
        mismatchDetected = displayedStatus !== actualStatus;

        if (!mismatchDetected) {
            throw new Error(
                "The test could not reproduce the status mismatch."
            );
        }

        stages.failureDetected = true;

        sendProgress(
            res,
            timeline,
            "detected",
            `Status mismatch detected for ${customer.name}. Displayed: "${displayedStatus}"; database: "${actualStatus}".`,
            {
                displayedStatus,
                actualStatus,
                tokenNumber: token,
                ...customerEvent(
                    `Mismatch detected. Displayed: ${displayedStatus}. Saved: ${actualStatus}.`
                ),
            }
        );

        await wait(600);

        // Begin recovery.
        sendProgress(
            res,
            timeline,
            "recovery_started",
            "Recovery started: synchronizing the simulated queue display with the latest saved database status.",
            {
                displayedStatus,
                actualStatus,
                tokenNumber: token,
                ...customerEvent(
                    `Recovery in progress. Updating the displayed status from ${displayedStatus} to ${actualStatus}.`
                ),
            }
        );

        // Correct the simulated display using the saved status.
        displayedStatus = savedRecord.status;
        stages.recoveryCompleted = true;

        await wait(400);

        // Verify the corrected status against the database again.
        const verifiedRecord = await Queue.findById(
            testQueue._id
        ).lean();

        synchronized =
            Boolean(verifiedRecord) &&
            displayedStatus === verifiedRecord.status;

        if (verifiedRecord) {
            actualStatus = verifiedRecord.status;
        }

        stages.verificationPassed = synchronized;

        sendProgress(
            res,
            timeline,
            synchronized ? "recovered" : "recovery_failed",
            synchronized
                ? `Recovery verified: the displayed status and database status both equal "${actualStatus}".`
                : "Recovery verification failed: the displayed status does not match the saved database status.",
            {
                displayedStatus,
                actualStatus,
                synchronized,
                tokenNumber: token,
                ...customerEvent(
                    synchronized
                        ? `Verified. Displayed status: ${displayedStatus}. Database status: ${actualStatus}.`
                        : `Verification failed. Displayed: ${displayedStatus}. Database: ${actualStatus}.`
                ),
            }
        );

        // Clean up only the temporary record created by this test.
        sendProgress(
            res,
            timeline,
            "cleanup",
            "Removing the temporary synchronization test customer.",
            {
                tokenNumber: token,
                ...customerEvent(
                    "Temporary test record scheduled for cleanup."
                ),
            }
        );

        await Queue.deleteMany({
            _id: { $in: [...testIds] },
        });

        const remaining = await Queue.countDocuments({
            _id: { $in: [...testIds] },
        });

        stages.cleanupSucceeded = remaining === 0;

        const success =
            stages.failureInjected &&
            stages.failureDetected &&
            stages.recoveryCompleted &&
            stages.verificationPassed &&
            stages.cleanupSucceeded;

        const result = {
            success,
            recovered:
                stages.recoveryCompleted &&
                stages.verificationPassed,
            completed: true,
            failureType: "synchronization-failure",
            message: success
                ? "Queue status synchronization failure detected, recovered, verified, and cleaned up successfully."
                : "The synchronization test did not pass all verification and cleanup checks.",
            timeline,
            durationMs:
                Date.now() -
                new Date(timeline[0].timestamp).getTime(),
           testResults: {
    customerA: {
        name: customer.name,
        token,
        status: displayedStatus,
    },
    tokenNumber: token,
    staleStatus: "Seated",
    correctedStatus: displayedStatus,
},
            verification: {
                mismatchDetected,
                synchronized,
                cleanupSucceeded: stages.cleanupSucceeded,
            },
            stages,
        };

        sendEvent(res, "result", { result });
        res.end();
    } catch (error) {
        console.error(
            "Synchronization test failed:",
            error
        );

        try {
            if (testIds.size > 0) {
                await Queue.deleteMany({
                    _id: { $in: [...testIds] },
                });

                const remaining = await Queue.countDocuments({
                    _id: { $in: [...testIds] },
                });

                stages.cleanupSucceeded = remaining === 0;
            } else {
                stages.cleanupSucceeded = true;
            }
        } catch (cleanupError) {
            console.error(
                "Synchronization test cleanup failed:",
                cleanupError
            );
        }

        if (streamStarted && !res.writableEnded) {
            sendProgress(
                res,
                timeline,
                "recovery_failed",
                `Synchronization test failed: ${error.message}`,
                {
                    displayedStatus,
                    actualStatus,
                    tokenNumber: token,
                    ...(token
                        ? customerEvent(
                            "The synchronization test encountered an error."
                        )
                        : {}),
                }
            );

            sendEvent(res, "result", {
                result: {
                    success: false,
                    recovered: false,
                    completed: false,
                    failureType: "synchronization-failure",
                    message: error.message,
                    timeline,
                    stages,
                    verification: {
                        mismatchDetected,
                        synchronized,
                        cleanupSucceeded: stages.cleanupSucceeded,
                    },
                },
            });

            res.end();
        } else if (!res.headersSent) {
            res.status(500).json({
                success: false,
                message: error.message,
            });
        }
    }
});













 // FAILURE 3: EXPIRED STOCK DETECTION & AUTO-RECOVERY

router.post("/expired-stock", async (req, res) => {
    let testBatchCode = null;
    let testIngredientId = null;
    let streamStarted = false;

    const affectedIngredientIds = new Set();

    const timeline = [];

    const progress = (stage, message, details = {}) => {
        sendProgress(res, timeline, stage, message, details);
    };

    // IMPORTANT: The frontend expects the result inside payload.result.
    const finish = (result) => {
        if (!res.writableEnded) {
            sendEvent(res, "result", { result });
            res.end();
        }
    };

    try {
        beginStream(res);
        streamStarted = true;

        progress(
            "injecting",
            "Starting expired-stock failure injection.",
            { status: "IN_PROGRESS" }
        );

        // Find an ingredient for the temporary test batch.
        const ingredient = await Ingredient.findOne().lean();

        if (!ingredient) {
            throw new Error(
                "No ingredient exists. Add an ingredient before testing Failure 3."
            );
        }

        testIngredientId = ingredient._id;
        testBatchCode = `SH-EXP-${Date.now()}`;

        // Create a temporary batch with an expiry date in the past.
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
await StockBatch.create({
    batchCode: testBatchCode,
    ingredientId: testIngredientId,

    // Required by your StockBatch schema
    quantity: 1,

    quantityReceived: 1,
    quantityRemaining: 1,
    unitCost: 1,
    totalCost: 1,
    receivedDate: yesterday,
    expiryDate: yesterday,
    status: "ACTIVE",
    expiredQuantity: 0
});

        affectedIngredientIds.add(String(testIngredientId));

        progress(
            "injected",
            "Failure injected: a temporary expired batch was created with ACTIVE status.",
            {
                batchCode: testBatchCode,
                ingredient:
                    ingredient.name ||
                    ingredient.ingredientName ||
                    "Test ingredient",
                expiryDate: yesterday.toISOString(),
                actualStatus: "ACTIVE",
                expectedStatus: "EXPIRED",
                remainingQuantity: 1
            }
        );

        await wait(400);

        // Detect expired batches incorrectly marked ACTIVE.
        progress(
            "detecting",
            "Scanning inventory for expired batches that are still ACTIVE."
        );

        const expiredBatches = await StockBatch.find({
            expiryDate: { $ne: null, $lt: new Date() },
            status: "ACTIVE",
            quantityRemaining: { $gt: 0 }
        });

        if (expiredBatches.length === 0) {
            throw new Error(
                "The injected expired batch could not be detected."
            );
        }

        for (const batch of expiredBatches) {
            affectedIngredientIds.add(String(batch.ingredientId));
        }

        progress(
            "detected",
            `Failure detected: ${expiredBatches.length} expired batch(es) are incorrectly marked ACTIVE.`,
            {
                detectedCount: expiredBatches.length,
                batches: expiredBatches.map((batch) => ({
                    batchCode: batch.batchCode,
                    status: batch.status,
                    expiryDate: batch.expiryDate,
                    remainingQuantity: batch.quantityRemaining
                }))
            }
        );

        await wait(400);

        // Recover by updating expired batch statuses and quantities.
        progress(
            "recovery_started",
            "Automatic recovery started: updating expired batch statuses."
        );

        for (const batch of expiredBatches) {
            const expiredAmount = Number(batch.quantityRemaining || 0);

            batch.expiredQuantity =
                Number(batch.expiredQuantity || 0) + expiredAmount;

            batch.quantityRemaining = 0;
            batch.status = "EXPIRED";

            await batch.save();
        }

        progress(
            "recovered",
            "Expired batches were marked EXPIRED and their quantities were recorded.",
            {
                recoveredCount: expiredBatches.length,
                batches: expiredBatches.map((batch) => ({
                    batchCode: batch.batchCode,
                    status: "EXPIRED",
                    expiredQuantity: batch.expiredQuantity
                }))
            }
        );

        // Recalculate usable inventory for all affected ingredients.
        progress(
            "inventory_recalculation",
            "Recalculating usable stock quantities for affected ingredients."
        );

        for (const ingredientId of affectedIngredientIds) {
            const usableBatches = await StockBatch.find({
                ingredientId: new mongoose.Types.ObjectId(ingredientId),
                status: "ACTIVE",
                quantityRemaining: { $gt: 0 },
                $or: [
                    { expiryDate: null },
                    { expiryDate: { $exists: false } },
                    { expiryDate: { $gt: new Date() } }
                ]
            }).lean();

            const totalUsableQuantity = usableBatches.reduce(
                (total, batch) =>
                    total + Number(batch.quantityRemaining || 0),
                0
            );

            await StockQuantity.findOneAndUpdate(
                { ingredientId: new mongoose.Types.ObjectId(ingredientId) },
                {
                    $set: {
                        totalQuantity: totalUsableQuantity,
                        lastUpdatedAt: new Date()
                    }
                },
                {
                    upsert: true,
                    returnDocument: "after",
                    runValidators: true,
                    setDefaultsOnInsert: true
                }
            );
        }

        progress(
            "inventory_updated",
            "Usable inventory quantities have been recalculated.",
            { affectedIngredients: affectedIngredientIds.size }
        );

        // Verify no expired batch still has usable stock marked ACTIVE.
        progress(
            "verification_started",
            "Verifying that no expired batch with remaining stock remains ACTIVE."
        );

        const remainingInvalidBatches = await StockBatch.countDocuments({
            expiryDate: { $ne: null, $lt: new Date() },
            status: "ACTIVE",
            quantityRemaining: { $gt: 0 }
        });

        if (remainingInvalidBatches > 0) {
            throw new Error(
                `Verification failed: ${remainingInvalidBatches} expired active batch(es) remain.`
            );
        }

        progress(
            "verification_passed",
            "Verification passed: no expired batch with remaining stock is still marked ACTIVE.",
            { remainingInvalidBatches: 0 }
        );

        // Remove only the temporary batch created for this test.
        progress(
            "cleanup_started",
            "Removing the temporary test batch created for failure injection."
        );

        await StockBatch.deleteOne({ batchCode: testBatchCode });

        // Recalculate the test ingredient after temporary batch removal.
        const remainingUsableBatches = await StockBatch.find({
            ingredientId: testIngredientId,
            status: "ACTIVE",
            quantityRemaining: { $gt: 0 },
            $or: [
                { expiryDate: null },
                { expiryDate: { $exists: false } },
                { expiryDate: { $gt: new Date() } }
            ]
        }).lean();

        const finalQuantity = remainingUsableBatches.reduce(
            (total, batch) =>
                total + Number(batch.quantityRemaining || 0),
            0
        );

        await StockQuantity.findOneAndUpdate(
            { ingredientId: testIngredientId },
            {
                $set: {
                    totalQuantity: finalQuantity,
                    lastUpdatedAt: new Date()
                }
            },
            {
                upsert: true,
                returnDocument: "after",
                runValidators: true,
                setDefaultsOnInsert: true
            }
        );

        progress(
            "cleanup",
            "Cleanup completed: temporary test batch removed and inventory recalculated.",
            { testBatchCode }
        );

        // Send the final result in the format expected by React.
        finish({
            success: true,
            recovered: true,
            completed: true,
            failureType: "expired-stock",
            message:
                "Expired stock failure detected, recovered, verified, and cleaned up successfully.",
            durationMs: Date.now() - new Date(timeline[0].timestamp).getTime(),
            timeline,
            summary: {
                failureInjected: true,
                failureDetected: true,
                recovered: true,
                verificationPassed: true,
                cleanupCompleted: true,
                batchesRecovered: expiredBatches.length,
                temporaryBatchRemoved: true
            }
        });
    } catch (error) {
        console.error("Expired stock self-healing error:", error);

        // Best-effort cleanup of the temporary batch.
        if (testBatchCode) {
            try {
                await StockBatch.deleteOne({ batchCode: testBatchCode });

                if (testIngredientId) {
                    const usableBatches = await StockBatch.find({
                        ingredientId: testIngredientId,
                        status: "ACTIVE",
                        quantityRemaining: { $gt: 0 },
                        $or: [
                            { expiryDate: null },
                            { expiryDate: { $exists: false } },
                            { expiryDate: { $gt: new Date() } }
                        ]
                    }).lean();

                    const totalQuantity = usableBatches.reduce(
                        (total, batch) =>
                            total + Number(batch.quantityRemaining || 0),
                        0
                    );

                    await StockQuantity.findOneAndUpdate(
                        { ingredientId: testIngredientId },
                        {
                            $set: {
                                totalQuantity,
                                lastUpdatedAt: new Date()
                            }
                        },
                        {
                            upsert: true,
                            returnDocument: "after",
                            runValidators: true,
                            setDefaultsOnInsert: true
                        }
                    );
                }
            } catch (cleanupError) {
                console.error(
                    "Temporary batch cleanup failed:",
                    cleanupError
                );
            }
        }

        const result = {
            success: false,
            recovered: false,
            completed: false,
            failureType: "expired-stock",
            message: error.message || "Expired stock recovery failed.",
            timeline
        };

        if (streamStarted && !res.writableEnded) {
            sendEvent(res, "result", { result });
            res.end();
        } else if (!res.headersSent) {
            res.status(500).json(result);
        }
    }
});




// FAILURE 4: OFFLINE INVENTORY OPERATION RECOVERY

async function generateOfflineBatchCode() {
    const [totalCount, numberedBatches] = await Promise.all([
        StockBatch.countDocuments(),
        StockBatch.find({
            batchCode: /^BAT-\d+$/i
        }).select("batchCode").lean()
    ]);

    let highestNumber = 0;

    for (const batch of numberedBatches) {
        const match = batch.batchCode.match(/^BAT-(\d+)$/i);

        if (match) {
            highestNumber = Math.max(highestNumber, Number(match[1]));
        }
    }

    let nextNumber = Math.max(totalCount, highestNumber) + 1;
    let batchCode = `BAT-${String(nextNumber).padStart(3, "0")}`;

    while (await StockBatch.exists({ batchCode })) {
        nextNumber += 1;
        batchCode = `BAT-${String(nextNumber).padStart(3, "0")}`;
    }

    return batchCode;
}

router.post("/offline-inventory/recover", async (req, res) => {
    const startedAt = Date.now();
    const timeline = [];
    const processedOperationIds = [];
    const failures = [];

    const progress = (stage, message, details = {}) => {
        sendProgress(res, timeline, stage, message, details);
    };

    const finish = (result) => {
        if (!res.writableEnded) {
            sendEvent(res, "result", { result });
            res.end();
        }
    };

    try {
        beginStream(res);

        progress(
            "started",
            "Starting synchronization of pending offline inventory operations."
        );

        if (mongoose.connection.readyState !== 1) {
            throw new Error("MongoDB is disconnected. Reconnect before recovery.");
        }

        const operations = Array.isArray(req.body.pendingOperations)
    ? req.body.pendingOperations
    : [];
        progress(
            "checking_connection",
            "Backend and MongoDB connection verified.",
            {
                backendAvailable: true,
                databaseConnected: true,
                pendingOperations: operations.length
            }
        );

        if (operations.length === 0) {
            finish({
                success: false,
                recovered: false,
                completed: true,
                failureType: "offline-inventory-recovery",
                message:
                    "There are no pending operations to synchronize. Queue a Stock In or Stock Out operation while offline, reconnect, and try again.",
                durationMs: Date.now() - startedAt,
                timeline,
                processedOperationIds: [],
                summary: {
                    pendingOperations: 0,
                    synchronizedOperations: 0,
                    failedOperations: 0,
                    databaseConnected: true
                },
                verification: {
                    backendAvailable: true,
                    databaseConnected: true,
                    recoveryVerified: false
                }
            });

            return;
        }

        for (const operation of operations) {
            const operationId = String(operation.operationId || "").trim();
            const type = String(operation.type || "").toLowerCase();
            const payload = operation.payload || {};

            if (!operationId) {
                failures.push({
                    operationId: null,
                    message: "An operation is missing its operation ID."
                });
                continue;
            }

            // A stable movement code prevents reapplying an operation
            // that the backend has already recorded.
            const movementCode = `OFF-${operationId}`;

            try {
                progress(
                    "operation_sync_started",
                    `Synchronizing ${type} operation ${operationId}.`,
                    { operationId, operationType: type }
                );

                const existingMovement = await StockMovement.findOne({
                    movementCode
                }).lean();

                if (existingMovement) {
                    processedOperationIds.push(operationId);

                    progress(
                        "operation_already_applied",
                        "This operation was already recorded. It will not be applied again.",
                        { operationId, movementCode, duplicatePrevented: true }
                    );

                    continue;
                }

                const ingredientId = String(payload.ingredientId || "");
                const quantity = Number(payload.quantity);

                if (!mongoose.Types.ObjectId.isValid(ingredientId)) {
                    throw new Error("The operation contains an invalid ingredient ID.");
                }

                if (!Number.isFinite(quantity) || quantity <= 0) {
                    throw new Error("Operation quantity must be greater than zero.");
                }

                if (type === "stock-in") {
                    const unitCost = Number(payload.unitCost);

                    if (!Number.isFinite(unitCost) || unitCost <= 0) {
                        throw new Error("Stock In requires a unit cost greater than zero.");
                    }

                    const receivedDate = payload.receivedDate
                        ? new Date(payload.receivedDate)
                        : new Date();

                    const expiryDate = payload.expiryDate
                        ? new Date(payload.expiryDate)
                        : null;

                    if (Number.isNaN(receivedDate.getTime())) {
                        throw new Error("Invalid received date.");
                    }

                    if (expiryDate && Number.isNaN(expiryDate.getTime())) {
                        throw new Error("Invalid expiry date.");
                    }

                    if (expiryDate && expiryDate < receivedDate) {
                        throw new Error("Expiry date cannot be before the received date.");
                    }

                    if (
                        payload.supplierId &&
                        !mongoose.Types.ObjectId.isValid(payload.supplierId)
                    ) {
                        throw new Error("Invalid supplier ID.");
                    }

                    const batchCode = await generateOfflineBatchCode();

                    await stockIn({
                        batchCode,
                        movementCode,
                        ingredientId,
                        quantity,
                        unitCost,
                        supplierId: payload.supplierId || null,
                        receivedDate,
                        expiryDate,
                        referenceCode: payload.referenceCode || ""
                    });
                } else if (type === "stock-out") {
                    await stockOut({
                        ...payload,
                        movementCode,
                        ingredientId,
                        quantity,
                        referenceCode: payload.referenceCode || ""
                    });
                } else {
                    throw new Error(
                        `Unsupported operation type: ${type || "missing type"}.`
                    );
                }

                // Verify that the business logic recorded the operation.
                const savedMovement = await StockMovement.findOne({
                    movementCode
                }).lean();

                if (!savedMovement) {
                    throw new Error(
                        "The operation was submitted, but its stock movement could not be verified. Check the stock logic before retrying."
                    );
                }

                processedOperationIds.push(operationId);

                progress(
                    "operation_synced",
                    `${type} operation synchronized and verified.`,
                    {
                        operationId,
                        movementCode,
                        movementVerified: true
                    }
                );
            } catch (operationError) {
                console.error(
                    `Offline operation ${operationId} failed:`,
                    operationError
                );

                failures.push({
                    operationId,
                    message: operationError.message
                });

                progress(
                    "operation_sync_failed",
                    `Operation ${operationId} could not be synchronized: ${operationError.message}`,
                    { operationId, operationType: type }
                );
            }
        }

        const allProcessed = failures.length === 0 &&
            processedOperationIds.length === operations.length;

        progress(
            allProcessed ? "verification_passed" : "verification_failed",
            allProcessed
                ? "All pending operations have been synchronized or verified as already applied."
                : "Some operations could not be synchronized. Those operations remain pending for review.",
            {
                submittedOperations: operations.length,
                synchronizedOperations: processedOperationIds.length,
                failedOperations: failures.length
            }
        );

        finish({
            success: allProcessed,
            recovered: allProcessed,
            completed: true,
            failureType: "offline-inventory-recovery",
            message: allProcessed
                ? "Pending inventory operations synchronized and verified successfully."
                : "Recovery was incomplete. Successfully processed operations were verified; failed operations need attention.",
            durationMs: Date.now() - startedAt,
            timeline,
            processedOperationIds,
            failures,
            summary: {
                pendingOperations: operations.length,
                synchronizedOperations: processedOperationIds.length,
                failedOperations: failures.length,
                databaseConnected: true,
                recoveryVerified: allProcessed
            },
            verification: {
                backendAvailable: true,
                databaseConnected: true,
                allOperationsProcessed: allProcessed,
                recoveryVerified: allProcessed
            }
        });
    } catch (error) {
        console.error("Offline inventory recovery failed:", error);

        if (!res.headersSent) {
            return res.status(500).json({
                success: false,
                message: error.message || "Offline inventory recovery failed."
            });
        }

        finish({
            success: false,
            recovered: false,
            completed: true,
            failureType: "offline-inventory-recovery",
            message: error.message || "Offline inventory recovery failed.",
            durationMs: Date.now() - startedAt,
            timeline,
            processedOperationIds,
            failures,
            summary: {
                synchronizedOperations: processedOperationIds.length,
                failedOperations: failures.length,
                databaseConnected: mongoose.connection.readyState === 1
            },
            verification: {
                databaseConnected: mongoose.connection.readyState === 1,
                recoveryVerified: false
            }
        });
    }
});



module.exports = router;
