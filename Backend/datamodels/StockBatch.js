
const mongoose = require('mongoose');

const stockBatchSchema = new mongoose.Schema(
    {
        batchCode: {
            type: String,
            required: true,
            unique: true,
            trim: true
        },
        ingredientId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Ingredient',
            required: true
        },
        quantity: {
            type: Number,
            required: true,
            min: 0
        },
        quantityRemaining: {
            type: Number,
            required: true,
            min: 0
        },
        unitCost: {
            type: Number,
            required: true,
            min: 0
        },
        supplierId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Supplier',
            default: null
        },
        receivedDate: {
            type: Date,
            required: true
        },
        expiryDate: {
            type: Date,
            default: null
        },
        isDeleted: {
    type: Boolean,
    default: false,
    index: true
},
        referenceCode: {
            type: String,
            trim: true,
            default: ''
        },
       status: {
    type: String,
    enum: ["ACTIVE", "INACTIVE", "EXPIRED"],
    default: "ACTIVE"
}
    },
    {
        timestamps: true
    }
);

module.exports = mongoose.model('StockBatch', stockBatchSchema);
