require("dotenv").config();
const mongoose = require("mongoose");

console.log("Connecting to:", process.env.MONGODB_URI);

mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("SUCCESS: Connected to MongoDB");
    process.exit(0);
  })
  .catch(err => {
    console.error("FAILURE:", err);
    process.exit(1);
  });
