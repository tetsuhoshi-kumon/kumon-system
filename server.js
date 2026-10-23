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

// --- MongoDB Atlas Connection ---
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/kumon-system';

mongoose.connect(MONGO_URI)
  .then(() => console.log('Successfully connected to MongoDB Atlas!'))
  .catch(err => console.error('MongoDB connection error:', err));

// --- Mongoose Schemas & Models ---
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

// In-Memory Active Sessions (for real-time live seat dashboard)
const activeStudentSessions = new Map();
const activeStaffSessions = new Map();
const checkedOutBooks = new Map();
const readyForPickupList = [];

// 1. Unified Scan Route
app.post('/api/scan', async (req, res) => {
  const { scanId, seatNumber } = req.body;
  const cleanId = String(scanId || '').trim();
  const now = new Date();

  try {
    // Check Staff Clock-In / Clock-Out
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
          clockIn: session.checkInTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          clockOut: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          durationMinutes,
          hoursWorked: parseFloat(hours),
          date: now.toISOString().split('T')[0]
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

    // Check Student Check-In / Check-Out
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
          checkIn: session.checkInTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          checkOut: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          durationMinutes,
          date: now.toISOString().split('T')[0]
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
          message: `${student.firstName} ${student.lastName} checked out. Time in center: ${durationMinutes} mins.`,
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
    res.status(500).json({ success: false, message: "Database transaction error." });
  }
});

// 2. Mark Student Ready for Parent Pickup
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
      readyTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  }

  res.json({ success: true, message: `${session.firstName} ${session.lastName} marked READY FOR PICKUP!` });
});

// 3. Parent Lobby Board Endpoint
app.get('/api/lobby-board', (req, res) => {
  const studying = Array.from(activeStudentSessions.values()).map(s => ({
    firstName: s.firstName,
    lastNameInitial: s.lastName ? s.lastName[0] + '.' : '',
    seatNumber: s.seatNumber,
    subject: s.subject
  }));

  res.json({ studying, readyForPickup: readyForPickupList });
});

// 4. Library Checkout / Return Route
app.post('/api/library/scan', async (req, res) => {
  const { studentId, assetTag, newCondition } = req.body;
  const cleanAsset = String(assetTag || '').trim();
  const cleanStudent = String(studentId || '').trim();

  try {
    const bookCopy = await Book.findOne({ assetTag: cleanAsset });
    if (!bookCopy) return res.status(404).json({ success: false, message: `Book Asset Tag "${cleanAsset}" not found.` });

    const now = new Date();

    if (checkedOutBooks.has(bookCopy.assetTag)) {
      const session = checkedOutBooks.get(bookCopy.assetTag);
      if (newCondition) {
        bookCopy.condition = newCondition;
        await bookCopy.save();
      }

      checkedOutBooks.delete(bookCopy.assetTag);
      return res.json({ action: "RETURN", message: `Returned "${bookCopy.title}".` });
    } else {
      const student = await Student.findOne({ id: cleanStudent });
      if (!student) return res.status(404).json({ success: false, message: "Valid Student ID required to check out." });

      const session = {
        assetTag: bookCopy.assetTag,
        title: bookCopy.title,
        level: bookCopy.level,
        studentId: student.id,
        studentName: `${student.firstName} ${student.lastName}`,
        checkoutDate: now.toISOString().split('T')[0]
      };

      checkedOutBooks.set(bookCopy.assetTag, session);
      return res.json({ action: "CHECKOUT", message: `Checked out "${bookCopy.title}" to ${student.firstName} ${student.lastName}!`, session });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: "Library scan failure." });
  }
});

// 5. Payroll Summary
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
  res.json({ success: true, message: "Payroll cycle reset successfully. New 2-week period started!" });
});

// Active Dashboard Endpoints
app.get('/api/active-students', (req, res) => {
  res.json(Array.from(activeStudentSessions.values()).map(s => ({
    ...s,
    isReady: readyForPickupList.some(p => p.studentId === s.studentId),
    checkInFormatted: s.checkInTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    minutesInCenter: Math.round((new Date() - s.checkInTime) / 60000)
  })));
});

app.get('/api/active-staff', (req, res) => {
  res.json(Array.from(activeStaffSessions.values()).map(s => ({
    ...s,
    checkInFormatted: s.checkInTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    minutesOnDuty: Math.round((new Date() - s.checkInTime) / 60000)
  })));
});

app.get('/api/active-books', (req, res) => { res.json(Array.from(checkedOutBooks.values())); });

app.post('/api/employees', async (req, res) => {
  const { id, firstName, lastName, role } = req.body;
  await Employee.findOneAndUpdate(
    { id: String(id).trim() },
    { id: String(id).trim(), firstName: String(firstName).trim(), lastName: String(lastName).trim(), role: role || "Assistant" },
    { upsert: true, new: true }
  );
  res.json({ success: true, message: `Saved employee ${firstName} ${lastName}!` });
});

app.post('/api/students', async (req, res) => {
  const { subject, id, lastName, firstName, parentPhone } = req.body;
  await Student.findOneAndUpdate(
    { id: String(id).trim() },
    { subject: subject || "Math", id: String(id).trim(), lastName: String(lastName).trim(), firstName: String(firstName).trim(), parentPhone: parentPhone || "" },
    { upsert: true, new: true }
  );
  res.json({ success: true, message: `Saved ${firstName} ${lastName} successfully!` });
});

app.get('/api/students-qr', async (req, res) => {
  const students = await Student.find();
  const list = await Promise.all(students.map(async s => ({ ...s.toObject(), qrCode: await QRCode.toDataURL(String(s.id)) })));
  res.json(list);
});

app.get('/api/employees-qr', async (req, res) => {
  const employees = await Employee.find();
  const list = await Promise.all(employees.map(async e => ({ ...e.toObject(), qrCode: await QRCode.toDataURL(String(e.id)) })));
  res.json(list);
});

app.get('/api/logs', async (req, res) => {
  const studentLogs = await StudentAttendanceLog.find();
  const staffLogs = await StaffShiftLog.find();
  res.json({ studentLogs, staffLogs, bookLogs: [] });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Kumon Check-In System running on port ${PORT}`));