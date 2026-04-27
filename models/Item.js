const mongoose = require('mongoose');

const itemSchema = new mongoose.Schema({
  item: { type: String, required: true, unique: true },
  stock_in: { type: Number, default: 0 },
  stock_out: { type: Number, default: 0 },
  cost_price: { type: Number, default: 0 },
  selling_price: { type: Number, default: 0 },
  quantity_sold: { type: Number, default: 0 },
  threshold: { type: Number, default: 20 },
  stock_history: [{
    quantity: Number,
    date: String
  }],
  sales_history: [{
    quantity: Number,
    date: String,
    actual_price: Number
  }]
});

module.exports = mongoose.model('Item', itemSchema);
