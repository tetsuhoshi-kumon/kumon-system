const fs = require('fs');
const mongoose = require('mongoose');

const uri = process.argv[2];

if (!uri) {
  console.error('Please provide your MongoDB connection string.');
  console.error('Usage: node migrate-to-atlas.js "mongodb+srv://..."');
  process.exit(1);
}

const studentSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  firstName: String,
  lastName: String,
  subject: { type: String, default: 'Math' },
  parentPhone: String
});

const employeeSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  firstName: String,
  lastName: String,
  role: { type: String, default: 'Assistant' }
});

const Student = mongoose.model('Student', studentSchema);
const Employee = mongoose.model('Employee', employeeSchema);

async function migrate() {
  try {
    await mongoose.connect(uri);
    console.log('Connected to MongoDB Atlas...');

    // Migrate Students
    if (fs.existsSync('students.json')) {
      const students = JSON.parse(fs.readFileSync('students.json', 'utf8'));
      if (students.length > 0) {
        const studentOps = students.map(s => ({
          updateOne: {
            filter: { id: String(s.id).trim() },
            update: {
              $set: {
                id: String(s.id).trim(),
                firstName: String(s.firstName || '').trim(),
                lastName: String(s.lastName || '').trim(),
                subject: s.subject || 'Math',
                parentPhone: s.parentPhone || ''
              }
            },
            upsert: true
          }
        }));
        await Student.bulkWrite(studentOps);
        console.log(` Successfully transferred ${students.length} students to MongoDB Atlas!`);
      } else {
        console.log('students.json is empty.');
      }
    } else {
      console.log('No students.json file found.');
    }

    // Migrate Employees
    if (fs.existsSync('employees.json')) {
      const employees = JSON.parse(fs.readFileSync('employees.json', 'utf8'));
      if (employees.length > 0) {
        const empOps = employees.map(e => ({
          updateOne: {
            filter: { id: String(e.id).trim() },
            update: {
              $set: {
                id: String(e.id).trim(),
                firstName: String(e.firstName || '').trim(),
                lastName: String(e.lastName || '').trim(),
                role: e.role || 'Assistant'
              }
            },
            upsert: true
          }
        }));
        await Employee.bulkWrite(empOps);
        console.log(` Successfully transferred ${employees.length} employees to MongoDB Atlas!`);
      }
    }

    console.log('\nMigration complete! All records are now permanently in the cloud.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }
}

migrate();
