const express = require('express');
const mongoose = require('mongoose');

const router = express.Router();

const StockBatch = require('../datamodels/StockBatch');
const Supplier = require('../datamodels/Supplier');
const { stockIn } = require('../inventoryLogic/stockInLogic');

// Generate the next sequential ID.
// Existing OFF-... and date-based BAT-... codes remain unchanged.
async function generateNextBatchCode() {
    const [totalCount, numberedBatches] = await Promise.all([
        StockBatch.countDocuments(),
        StockBatch.find({
            batchCode: /^BAT-\d+$/i
        })
            .select('batchCode')
            .lean()
    ]);

    const highestNumber = numberedBatches.reduce((highest, batch) => {
        const match = batch.batchCode.match(/^BAT-(\d+)$/i);

        return match
            ? Math.max(highest, Number(match[1]))
            : highest;
    }, 0);

    const nextNumber = Math.max(totalCount, highestNumber) + 1;

    return `BAT-${String(nextNumber).padStart(3, '0')}`;
}

// PREVIEW: Get the next batch ID when the form opens.
// The ID is confirmed again during the actual save.
router.get('/next-code', async (req, res) => {
    try {
        const batchCode = await generateNextBatchCode();

        res.status(200).json({
            success: true,
            data: { batchCode }
        });
    } catch (error) {
        console.error('Batch ID generation error:', error);

        res.status(500).json({
            success: false,
            message: 'Could not generate the next batch ID.'
        });
    }
});

// CREATE: Receive stock and assign its permanent ID on the server.
router.post('/', async (req, res) => {
    try {
        const {
            movementCode,
            ingredientId,
            quantity,
            unitCost,
            supplierId,
            receivedDate,
            expiryDate,
            referenceCode
        } = req.body;

        if (!movementCode) {
            return res.status(400).json({
                success: false,
                message: 'Movement code is required.'
            });
        }

        if (!mongoose.isValidObjectId(ingredientId)) {
            return res.status(400).json({
                success: false,
                message: 'A valid ingredient ID is required.'
            });
        }

        if (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Quantity must be greater than zero.'
            });
        }

        if (!Number.isFinite(Number(unitCost)) || Number(unitCost) <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Unit cost must be greater than zero.'
            });
        }

        if (supplierId && !mongoose.isValidObjectId(supplierId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid supplier ID.'
            });
        }

        let result = null;

        // Retry a batch-code collision if two requests save at the same time.
        for (let attempt = 0; attempt < 5; attempt++) {
            const batchCode = await generateNextBatchCode();

            try {
                result = await stockIn({
                    movementCode,
                    batchCode,
                    ingredientId,
                    quantity: Number(quantity),
                    unitCost: Number(unitCost),
                    supplierId: supplierId || null,
                    receivedDate,
                    expiryDate,
                    referenceCode
                });

                break;
            } catch (error) {
                const batchCodeConflict =
                    error.code === 11000 &&
                    (
                        error.keyPattern?.batchCode ||
                        error.message?.includes('batchCode_1')
                    );

                if (batchCodeConflict && attempt < 4) {
                    continue;
                }

                throw error;
            }
        }

        if (!result) {
            throw new Error(
                'Could not generate a unique batch ID. Please try again.'
            );
        }

        res.status(201).json({
            success: true,
            message: `Stock received successfully. Batch ID: ${result.batch.batchCode}`,
            data: result
        });
    } catch (error) {
        console.error('Receive stock error:', error);

        res.status(error.code === 11000 ? 409 : 400).json({
            success: false,
            message: error.code === 11000
                ? 'A duplicate batch code or movement code was detected.'
                : error.message
        });
    }
});

// READ: Get all batches, with optional filters.
router.get('/', async (req, res) => {
    try {
        const filter = {};
        filter.isDeleted = { $ne: true };

        if (req.query.ingredientId) {
            if (!mongoose.isValidObjectId(req.query.ingredientId)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid ingredient ID.'
                });
            }

            filter.ingredientId = req.query.ingredientId;
        }

        if (req.query.status) {
            const allowedStatuses = [
                'Available',
                'Depleted',
                'Expired',
                'Quarantined'
            ];

            if (!allowedStatuses.includes(req.query.status)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid batch status.'
                });
            }

            filter.status = req.query.status;
        }

        const batches = await StockBatch.find(filter)
            .populate('ingredientId', 'ingredientCode name unit')
            .populate('supplierId', 'supplierCode name')
            .sort({ receivedDate: -1 });

        res.status(200).json({
            success: true,
            count: batches.length,
            data: batches
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// READ: Get one batch by ID.
router.get('/:id', async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid batch ID.'
            });
        }

        const batch = await StockBatch.findById(req.params.id)
            .populate('ingredientId', 'ingredientCode name unit')
            .populate('supplierId', 'supplierCode name');

        if (!batch) {
            return res.status(404).json({
                success: false,
                message: 'Stock batch not found.'
            });
        }

        res.status(200).json({
            success: true,
            data: batch
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// UPDATE: Change only batch metadata.
router.put('/:id', async (req, res) => {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid batch ID.'
            });
        }

        const allowedFields = ['expiryDate', 'supplierId'];
        const updates = {};

        for (const field of allowedFields) {
            if (req.body[field] !== undefined) {
                updates[field] = req.body[field];
            }
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Provide expiryDate or supplierId to update.'
            });
        }

        const existingBatch = await StockBatch.findById(req.params.id);

        if (!existingBatch) {
            return res.status(404).json({
                success: false,
                message: 'Stock batch not found.'
            });
        }

        if (updates.expiryDate !== undefined) {
            if (updates.expiryDate === null || updates.expiryDate === '') {
                updates.expiryDate = null;
            } else {
                const expiry = new Date(updates.expiryDate);

                if (Number.isNaN(expiry.getTime())) {
                    return res.status(400).json({
                        success: false,
                        message: 'Invalid expiry date.'
                    });
                }

                if (expiry < new Date(existingBatch.receivedDate)) {
                    return res.status(400).json({
                        success: false,
                        message: 'Expiry date cannot be before the received date.'
                    });
                }

                updates.expiryDate = expiry;
            }
        }

        if (updates.supplierId !== undefined) {
            if (updates.supplierId === null || updates.supplierId === '') {
                updates.supplierId = null;
            } else {
                if (!mongoose.isValidObjectId(updates.supplierId)) {
                    return res.status(400).json({
                        success: false,
                        message: 'Invalid supplier ID.'
                    });
                }

                const supplier = await Supplier.findOne({
                    _id: updates.supplierId,
                    isActive: true
                });

                if (!supplier) {
                    return res.status(400).json({
                        success: false,
                        message: 'Active supplier not found.'
                    });
                }
            }
        }

        const batch = await StockBatch.findByIdAndUpdate(
            req.params.id,
            { $set: updates },
            {
                returnDocument: 'after',
                runValidators: true
            }
        )
            .populate('ingredientId', 'ingredientCode name unit')
            .populate('supplierId', 'supplierCode name');

        res.status(200).json({
            success: true,
            message: 'Stock batch updated successfully.',
            data: batch
        });
    } catch (error) {
        res.status(error.code === 11000 ? 409 : 400).json({
            success: false,
            message: error.code === 11000
                ? 'A duplicate record was detected.'
                : error.message
        });
    }
});

// DELETE: Safely remove a depleted batch from the active list.
// Keep the batch document so movement history remains valid.
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        if (!mongoose.isValidObjectId(id)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid batch ID.'
            });
        }

        const batch = await StockBatch.findById(id);

        if (!batch) {
            return res.status(404).json({
                success: false,
                message: 'Stock batch not found.'
            });
        }

        if (batch.isDeleted) {
            return res.status(200).json({
                success: true,
                message: 'Batch has already been removed.'
            });
        }

        const remainingQuantity = Number(
            batch.quantityRemaining ?? batch.quantity ?? 0
        );

        // Never hide stock that is still available.
        if (remainingQuantity > 0) {
            return res.status(409).json({
                success: false,
                message:
                    `Cannot remove this batch because ${remainingQuantity} units remain. ` +
                    'Use Stock Out first so inventory quantities remain accurate.'
            });
        }
await StockBatch.updateOne(
    { _id: batch._id },
    {
        $set: {
            isDeleted: true,
            status: 'INACTIVE'
        }
    }
);

        return res.status(200).json({
            success: true,
            message:
                'Batch removed from the active list. Movement history has been preserved.',
            data: {
                _id: batch._id,
                batchCode: batch.batchCode
            }
        });
    } catch (error) {
        console.error('Delete stock batch error:', error);

        return res.status(500).json({
            success: false,
            message: 'Could not remove the stock batch.'
        });
    }
});

module.exports = router;