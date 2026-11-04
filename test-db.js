const mongoose = require('mongoose');

const uri = process.argv[2];

if (!uri) {
  console.error('Error: Please pass your connection string.');
  console.error('Usage: node test-db.js "mongodb+srv://..."');
  process.exit(1);
}

console.log('Attempting connection to MongoDB Atlas...');

mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 })
  .then(() => {
    console.log(' SUCCESS: Connected to MongoDB Atlas smoothly!');
    process.exit(0);
  })
  .catch(err => {
    console.error(' FAILURE: Connection error:');
    console.error(err.message);
    process.exit(1);
  });
