
const mongoose = require('mongoose');

const Ingredient = require('../datamodels/Ingredient');
const StockBatch = require('../datamodels/StockBatch');
const StockMovement = require('../datamodels/StockMovement');
const StockQuantity = require('../datamodels/StockQuantity');
const ProcessedInventoryOperation = require('../datamodels/ProcessedInventoryOperation');

const stockIn = async (data) => {
    const {
        operationId,
        movementCode,
        batchCode,
        ingredientId,
        quantity,
        unitCost,
        supplierId,
        receivedDate,
        expiryDate,
        performedBy,
        referenceCode
    } = data;

    if (!movementCode || !batchCode || !ingredientId) {
        throw new Error(
            'Movement code, batch code, and ingredient are required.'
        );
    }

    if (operationId && typeof operationId !== 'string') {
        throw new Error('Operation ID must be a string.');
    }

    if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new Error('Quantity must be greater than zero.');
    }

    if (!Number.isFinite(unitCost) || unitCost < 0) {
        throw new Error('Unit cost cannot be negative.');
    }

    if (
        expiryDate &&
        receivedDate &&
        new Date(expiryDate) < new Date(receivedDate)
    ) {
        throw new Error('Expiry date cannot be before the received date.');
    }

    const session = await mongoose.startSession();

    try {
        let result;

        await session.withTransaction(async () => {
            // If this operation was already completed, return its saved result.
            if (operationId) {
                const previousOperation =
                    await ProcessedInventoryOperation.findOne({
                        operationId
                    }).session(session);

                if (previousOperation) {
                    if (previousOperation.operationType !== 'STOCK_IN') {
                        throw new Error(
                            'This operation ID was already used for another operation type.'
                        );
                    }

                    const previousBatch = await StockBatch.findById(
                        previousOperation.result.batchId
                    ).session(session);

                    if (!previousBatch) {
                        throw new Error(
                            'Previously processed stock batch could not be found.'
                        );
                    }

                    result = {
                        batch: previousBatch,
                        totalQuantity:
                            previousOperation.result.totalQuantity,
                        alreadyProcessed: true
                    };

                    return;
                }
            }

            const ingredient = await Ingredient.findOne({
                _id: ingredientId,
                isActive: true
            }).session(session);

            if (!ingredient) {
                throw new Error('Active ingredient not found.');
            }

            
const batch = await StockBatch.create(
    [{
    batchCode,
    ingredientId,
    quantity: Number(quantity), // Add this required field
    quantityReceived: Number(quantity),
    quantityRemaining: Number(quantity),
    unitCost: Number(unitCost),
    totalCost: Number(quantity) * Number(unitCost),
    supplierId: supplierId || null,
    receivedDate: receivedDate || new Date(),
    expiryDate: expiryDate || null,
    status: "ACTIVE"
}],
    { session }
);

await StockMovement.create(
    [{
        movementCode,
        ingredientId,
        batchId: batch[0]._id,
        movementType: 'Stock In',
        quantity,
        unit: ingredient.unit,
        reason: 'New stock received',
        referenceCode: referenceCode || null,
        performedBy: performedBy || null,
        movementDate: receivedDate || new Date()
    }],
    { session }
);


            const totals = await StockBatch.aggregate([
                {
                    $match: {
                        ingredientId: ingredient._id
                    }
                },
                {
                    $group: {
                        _id: '$ingredientId',
                        totalQuantity: {
                            $sum: '$quantityRemaining'
                        }
                    }
                }
            ]).session(session);

            const totalQuantity =
                totals.length > 0 ? totals[0].totalQuantity : 0;

            const stockQuantity = await StockQuantity.findOneAndUpdate(
                { ingredientId: ingredient._id },
                {
                    $set: {
                        totalQuantity,
                        lastUpdatedAt: new Date()
                    }
                },
                {
                    session,
                    returnDocument: 'after',
                    upsert: true,
                    runValidators: true,
                    setDefaultsOnInsert: true
                }
            );

            result = {
                batch: batch[0],
                totalQuantity,
                alreadyProcessed: false
            };

            // Save the operation in the same transaction as the stock update.
            // If the transaction fails, this record also rolls back.
            if (operationId) {
                await ProcessedInventoryOperation.create(
                    [{
                        operationId,
                        operationType: 'STOCK_IN',
                        result: {
                            batchId: batch[0]._id,
                            totalQuantity: stockQuantity.totalQuantity
                        }
                    }],
                    { session }
                );
            }
        });

        return result;
    } finally {
        await session.endSession();
    }
};

module.exports = { stockIn };
