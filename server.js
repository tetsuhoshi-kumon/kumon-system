const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const mongoose = require('mongoose');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- Timezone Helper Functions ---
const TIMEZONE = process.env.TZ || 'America/Los_Angeles';

const getTime = (date = new Date()) =>
  date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: TIMEZONE });

const getDate = (date = new Date()) =>
  date.toLocaleDateString('en-CA', { timeZone: TIMEZONE });

// --- MongoDB Atlas Connection ---
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://tetsuhoshi_db_user:-BMc_UJc5Bz3XkB@tetsuhoshi-kumon.l0lkzen.mongodb.net/kumon?retryWrites=true&w=majority';

mongoose.connect(MONGO_URI)
  .then(() => console.log('Successfully connected to MongoDB Atlas!'))
  .catch(err => console.error('MongoDB connection error:', err));

// --- Schemas & Models ---
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

const bookSchema = new mongoose.Schema({
  assetTag: { type: String, required: true, unique: true },
  isbn: String,
  title: String,
  level: String,
  condition: { type: String, default: 'Good' }
});

const staffShiftLogSchema = new mongoose.Schema({
  role: String,
  id: String,
  lastName: String,
  firstName: String,
  clockIn: String,
  clockOut: String,
  durationMinutes: Number,
  hoursWorked: Number,
  date: String
});

const studentAttendanceLogSchema = new mongoose.Schema({
  subject: String,
  studentId: String,
  lastName: String,
  firstName: String,
  checkIn: String,
  checkOut: String,
  durationMinutes: Number,
  date: String
});

const Student = mongoose.model('Student', studentSchema);
const Employee = mongoose.model('Employee', employeeSchema);
const Book = mongoose.model('Book', bookSchema);
const StaffShiftLog = mongoose.model('StaffShiftLog', staffShiftLogSchema);
const StudentAttendanceLog = mongoose.model('StudentAttendanceLog', studentAttendanceLogSchema);

// In-Memory Live State
const activeStudentSessions = new Map();
const activeStaffSessions = new Map();
const checkedOutBooks = new Map();
const readyForPickupList = [];

// --- 1. Scan Endpoint ---
app.post('/api/scan', async (req, res) => {
  const { scanId, seatNumber } = req.body;
  const cleanId = String(scanId || '').trim();
  const now = new Date();

  try {
    // Check Staff First
    const staffMember = await Employee.findOne({ id: cleanId });
    if (staffMember) {
      if (activeStaffSessions.has(staffMember.id)) {
        const session = activeStaffSessions.get(staffMember.id);
        const durationMinutes = Math.round((now - session.checkInTime) / 60000);
        const hours = (durationMinutes / 60).toFixed(2);

        const logEntry = new StaffShiftLog({
          role: staffMember.role,
          id: staffMember.id,
          lastName: staffMember.lastName,
          firstName: staffMember.firstName,
          clockIn: getTime(session.checkInTime),
          clockOut: getTime(now),
          durationMinutes,
          hoursWorked: parseFloat(hours),
          date: getDate(now)
        });

        await logEntry.save();
        activeStaffSessions.delete(staffMember.id);

        return res.json({
          type: "STAFF",
          action: "CHECK_OUT",
          firstName: staffMember.firstName,
          lastName: staffMember.lastName,
          message: `Staff Clock-Out: ${staffMember.firstName} ${staffMember.lastName} (${hours} hrs worked).`,
          log: logEntry
        });
      } else {
        const session = {
          role: staffMember.role,
          id: staffMember.id,
          lastName: staffMember.lastName,
          firstName: staffMember.firstName,
          checkInTime: now
        };
        activeStaffSessions.set(staffMember.id, session);

        return res.json({
          type: "STAFF",
          action: "CHECK_IN",
          firstName: staffMember.firstName,
          lastName: staffMember.lastName,
          message: `Staff Clock-In: ${staffMember.firstName} ${staffMember.lastName} (${staffMember.role}).`,
          session
        });
      }
    }

    // Check Student
    const student = await Student.findOne({ id: cleanId });
    if (student) {
      if (activeStudentSessions.has(student.id)) {
        const session = activeStudentSessions.get(student.id);
        const durationMinutes = Math.round((now - session.checkInTime) / 60000);

        const logEntry = new StudentAttendanceLog({
          subject: student.subject,
          studentId: student.id,
          lastName: student.lastName,
          firstName: student.firstName,
          checkIn: getTime(session.checkInTime),
          checkOut: getTime(now),
          durationMinutes,
          date: getDate(now)
        });

        await logEntry.save();
        activeStudentSessions.delete(student.id);

        const pIdx = readyForPickupList.findIndex(p => p.studentId === student.id);
        if (pIdx >= 0) readyForPickupList.splice(pIdx, 1);

        return res.json({
          type: "STUDENT",
          action: "CHECK_OUT",
          firstName: student.firstName,
          lastName: student.lastName,
          subject: student.subject,
          message: `${student.firstName} ${student.lastName} checked out. Total time: ${durationMinutes} mins.`,
          log: logEntry
        });
      } else {
        const session = {
          subject: student.subject,
          studentId: student.id,
          lastName: student.lastName,
          firstName: student.firstName,
          parentPhone: student.parentPhone || '',
          seatNumber: seatNumber || "Unassigned",
          checkInTime: now
        };
        activeStudentSessions.set(student.id, session);

        return res.json({
          type: "STUDENT",
          action: "CHECK_IN",
          firstName: student.firstName,
          lastName: student.lastName,
          subject: student.subject,
          seatNumber: session.seatNumber,
          message: `${student.firstName} ${student.lastName} checked in at ${session.seatNumber}.`,
          session
        });
      }
    }

    return res.status(404).json({ success: false, message: "Scanned ID not recognized as Student or Staff." });
  } catch (err) {
    console.error("Scan Error:", err);
    res.status(500).json({ success: false, message: err.message || "Database transaction error." });
  }
});

// --- 2. Ready For Pickup & Lobby Board ---
app.post('/api/ready-pickup', (req, res) => {
  const { studentId } = req.body;
  const session = activeStudentSessions.get(studentId);

  if (!session) return res.status(404).json({ success: false, message: "Student is not currently checked in." });

  if (!readyForPickupList.some(p => p.studentId === studentId)) {
    readyForPickupList.push({
      studentId: session.studentId,
      firstName: session.firstName,
      lastName: session.lastName,
      seatNumber: session.seatNumber,
      readyTime: getTime(new Date())
    });
  }

  res.json({ success: true, message: `${session.firstName} ${session.lastName} marked READY FOR PICKUP!` });
});

app.get('/api/lobby-board', (req, res) => {
  const studying = Array.from(activeStudentSessions.values()).map(s => ({
    firstName: s.firstName,
    lastNameInitial: s.lastName ? s.lastName[0] + '.' : '',
    seatNumber: s.seatNumber,
    subject: s.subject
  }));

  res.json({ studying, readyForPickup: readyForPickupList });
});

// --- 3. Student Management (Add, Get QR, Delete) ---
app.post('/api/students', async (req, res) => {
  const { subject, id, lastName, firstName, parentPhone } = req.body;
  await Student.findOneAndUpdate(
    { id: String(id).trim() },
    {
      subject: subject || "Math",
      id: String(id).trim(),
      lastName: String(lastName || '').trim(),
      firstName: String(firstName || '').trim(),
      parentPhone: parentPhone || ""
    },
    { upsert: true, new: true }
  );
  res.json({ success: true, message: `Saved ${firstName} ${lastName} successfully!` });
});

app.get('/api/students-qr', async (req, res) => {
  const students = await Student.find().sort({ lastName: 1, firstName: 1 });
  const list = await Promise.all(students.map(async s => ({
    ...s.toObject(),
    qrCode: await QRCode.toDataURL(String(s.id))
  })));
  res.json(list);
});

app.delete('/api/students/:id', async (req, res) => {
  const studentId = String(req.params.id || '').trim();
  try {
    const deletedStudent = await Student.findOneAndDelete({ id: studentId });
    if (!deletedStudent) {
      return res.status(404).json({ success: false, message: `Student ID "${studentId}" not found.` });
    }
    if (activeStudentSessions.has(studentId)) activeStudentSessions.delete(studentId);
    const pIdx = readyForPickupList.findIndex(p => p.studentId === studentId);
    if (pIdx >= 0) readyForPickupList.splice(pIdx, 1);

    res.json({ success: true, message: `Student ${deletedStudent.firstName} ${deletedStudent.lastName} removed.` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete student.' });
  }
});

// --- 4. Employee Management (Add, Get QR, Delete) ---
app.post('/api/employees', async (req, res) => {
  const { id, firstName, lastName, role } = req.body;
  await Employee.findOneAndUpdate(
    { id: String(id).trim() },
    {
      id: String(id).trim(),
      firstName: String(firstName || '').trim(),
      lastName: String(lastName || '').trim(),
      role: role || "Assistant"
    },
    { upsert: true, new: true }
  );
  res.json({ success: true, message: `Saved employee ${firstName} ${lastName}!` });
});

app.get('/api/employees-qr', async (req, res) => {
  const employees = await Employee.find().sort({ lastName: 1, firstName: 1 });
  const list = await Promise.all(employees.map(async e => ({
    ...e.toObject(),
    qrCode: await QRCode.toDataURL(String(e.id))
  })));
  res.json(list);
});

app.delete('/api/employees/:id', async (req, res) => {
  const employeeId = String(req.params.id || '').trim();
  try {
    const deletedEmployee = await Employee.findOneAndDelete({ id: employeeId });
    if (!deletedEmployee) {
      return res.status(404).json({ success: false, message: `Employee ID "${employeeId}" not found.` });
    }
    if (activeStaffSessions.has(employeeId)) activeStaffSessions.delete(employeeId);
    res.json({ success: true, message: `Employee ${deletedEmployee.firstName} ${deletedEmployee.lastName} removed.` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete employee.' });
  }
});

// --- 5. CSV Roster Bulk Upload ---
app.post('/api/upload-roster', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

  const results = [];
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on('data', (row) => {
      const id = row.id || row.ID || row['Student ID'] || row['student_id'];
      const firstName = row.firstName || row['First Name'] || row.first_name || '';
      const lastName = row.lastName || row['Last Name'] || row.last_name || '';
      const subject = row.subject || row.Subject || 'Math';
      const parentPhone = row.parentPhone || row['Parent Phone'] || row.phone || '';

      if (id) {
        results.push({
          id: String(id).trim(),
          firstName: String(firstName).trim(),
          lastName: String(lastName).trim(),
          subject: String(subject).trim(),
          parentPhone: String(parentPhone).trim()
        });
      }
    })
    .on('end', async () => {
      try {
        const operations = results.map(s => ({
          updateOne: { filter: { id: s.id }, update: { $set: s }, upsert: true }
        }));
        if (operations.length > 0) await Student.bulkWrite(operations);
        fs.unlinkSync(req.file.path);
        res.json({ success: true, message: `Imported ${results.length} students into MongoDB Atlas!` });
      } catch (err) {
        res.status(500).json({ success: false, message: 'Database import failed.' });
      }
    });
});

// --- 6. Active Live Dashboards & Payroll ---
app.get('/api/active-students', (req, res) => {
  res.json(Array.from(activeStudentSessions.values()).map(s => ({
    ...s,
    isReady: readyForPickupList.some(p => p.studentId === s.studentId),
    checkInFormatted: getTime(s.checkInTime),
    minutesInCenter: Math.round((new Date() - s.checkInTime) / 60000)
  })));
});

app.get('/api/active-staff', (req, res) => {
  res.json(Array.from(activeStaffSessions.values()).map(s => ({
    ...s,
    checkInFormatted: getTime(s.checkInTime),
    minutesOnDuty: Math.round((new Date() - s.checkInTime) / 60000)
  })));
});

app.get('/api/payroll-summary', async (req, res) => {
  try {
    const employees = await Employee.find();
    const staffShiftLogs = await StaffShiftLog.find();
    const summaryMap = new Map();

    employees.forEach(emp => {
      summaryMap.set(emp.id, {
        id: emp.id,
        firstName: emp.firstName,
        lastName: emp.lastName,
        role: emp.role,
        totalShifts: 0,
        totalMinutes: 0,
        totalHours: 0
      });
    });

    staffShiftLogs.forEach(log => {
      if (summaryMap.has(log.id)) {
        const record = summaryMap.get(log.id);
        record.totalShifts += 1;
        record.totalMinutes += log.durationMinutes || 0;
        record.totalHours = (record.totalMinutes / 60).toFixed(2);
      }
    });

    res.json(Array.from(summaryMap.values()));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch payroll summary." });
  }
});

app.post('/api/reset-payroll', async (req, res) => {
  await StaffShiftLog.deleteMany({});
  res.json({ success: true, message: "Payroll cycle reset successfully." });
});

app.get('/api/logs', async (req, res) => {
  const studentLogs = await StudentAttendanceLog.find().sort({ _id: -1 }).limit(100);
  const staffLogs = await StaffShiftLog.find().sort({ _id: -1 }).limit(100);
  res.json({ studentLogs, staffLogs });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Kumon Check-In System running on port ${PORT}`));