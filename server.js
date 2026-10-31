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

function resolveClockOutDate(checkInDate, timeInput) {
  if (!timeInput || !timeInput.trim()) return new Date();

  const str = timeInput.trim();
  const match = str.match(/^(\d{1,2}):(\d{2})(?:\s*([ap]m))?$/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const ampm = match[3] ? match[3].toLowerCase() : null;

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

  if (ampm === 'pm' && hours < 12) hours += 12;
  if (ampm === 'am' && hours === 12) hours = 0;

  const target = new Date(checkInDate);
  target.setHours(hours, minutes, 0, 0);

  if (!ampm && target < checkInDate && hours < 12) {
    target.setHours(hours + 12, minutes, 0, 0);
  }

  return target;
}

// --- MongoDB Atlas Connection & Legacy Index Sanitization ---
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://tetsuhoshi_db_user:-BMc_UJc5Bz3XkB@tetsuhoshi-kumon.l0lkzen.mongodb.net/kumon?retryWrites=true&w=majority';

mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log('Successfully connected to MongoDB Atlas!');
    try {
      const bookCollection = mongoose.connection.collection('books');
      const indexes = await bookCollection.indexes();
      for (const idx of indexes) {
        if (idx.name !== '_id_' && idx.name !== 'bookId_1') {
          await bookCollection.dropIndex(idx.name);
          console.log(`[Auto-Repair] Dropped stale legacy index: ${idx.name}`);
        }
      }
    } catch (idxErr) {
      // Safe to ignore if collection has no custom indexes yet
    }
  })
  .catch(err => console.error('MongoDB connection error:', err));

// --- Schemas & Models ---

// Student Schemas
const studentSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  firstName: String,
  lastName: String,
  subject: { type: String, default: 'Math' },
  parentPhone: String
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

const activeStudentSessionSchema = new mongoose.Schema({
  studentId: { type: String, required: true, unique: true },
  firstName: String,
  lastName: String,
  subject: { type: String, default: 'Math' },
  parentPhone: String,
  seatNumber: { type: String, default: 'Unassigned' },
  checkInTime: { type: Date, default: Date.now },
  isReady: { type: Boolean, default: false },
  readyTime: String
});

// Staff Schemas
const employeeSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  firstName: String,
  lastName: String,
  role: { type: String, default: 'Assistant' }
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

const activeStaffSessionSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  firstName: String,
  lastName: String,
  role: { type: String, default: 'Assistant' },
  checkInTime: { type: Date, default: Date.now }
});

// Book Library Schemas
const bookSchema = new mongoose.Schema({
  bookId: { type: String, required: true, unique: true },
  id: { type: String }, // Mirrors bookId to neutralize legacy index collisions
  title: { type: String, required: true },
  author: { type: String, default: '' },
  level: { type: String, default: 'General' },
  bookNumber: { type: String, default: '' },
  status: { type: String, enum: ['AVAILABLE', 'CHECKED_OUT'], default: 'AVAILABLE' },
  currentHolderId: { type: String, default: null },
  currentHolderName: { type: String, default: null },
  parentPhone: { type: String, default: '' },
  checkoutDate: { type: String, default: null },
  checkoutTime: { type: Date, default: null }
});

const bookLogSchema = new mongoose.Schema({
  bookId: String,
  title: String,
  author: String,
  level: String,
  bookNumber: String,
  studentId: String,
  studentName: String,
  parentPhone: String,
  checkoutDate: String,
  returnDate: String,
  daysOut: Number
});

const Student = mongoose.model('Student', studentSchema);
const StudentAttendanceLog = mongoose.model('StudentAttendanceLog', studentAttendanceLogSchema);
const ActiveStudentSession = mongoose.model('ActiveStudentSession', activeStudentSessionSchema);

const Employee = mongoose.model('Employee', employeeSchema);
const StaffShiftLog = mongoose.model('StaffShiftLog', staffShiftLogSchema);
const ActiveStaffSession = mongoose.model('ActiveStaffSession', activeStaffSessionSchema);

const Book = mongoose.model('Book', bookSchema);
const BookLog = mongoose.model('BookLog', bookLogSchema);

// --- Collision-Proof ID Generators ---

async function generateUniqueTempId() {
  let unique = false;
  let tempId = '';
  while (!unique) {
    const timePart = Date.now().toString(36).toUpperCase().slice(-5);
    const randPart = Math.floor(10 + Math.random() * 90);
    tempId = `TEMP-${timePart}-${randPart}`;
    const existing = await Student.findOne({ id: tempId });
    if (!existing) unique = true;
  }
  return tempId;
}

async function generateUniqueBookId(level = 'GEN') {
  let unique = false;
  let bookId = '';
  const cleanLevel = level.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 4) || 'GEN';
  while (!unique) {
    const timePart = Date.now().toString(36).toUpperCase().slice(-4);
    const randPart = Math.floor(10 + Math.random() * 90);
    bookId = `BK-${cleanLevel}-${timePart}-${randPart}`;
    const existing = await Book.findOne({ bookId });
    if (!existing) unique = true;
  }
  return bookId;
}

// --- 1. Kiosk Scan Endpoint (30s Double-Scan Safeguard) ---
app.post('/api/scan', async (req, res) => {
  const { scanId, seatNumber } = req.body;
  const cleanId = String(scanId || '').trim();
  const now = new Date();

  try {
    // A. Staff Scan Branch
    const staffMember = await Employee.findOne({ id: cleanId });
    if (staffMember) {
      const activeSession = await ActiveStaffSession.findOne({ id: staffMember.id });

      if (activeSession) {
        const checkInTime = new Date(activeSession.checkInTime);
        const secondsElapsed = Math.round((now - checkInTime) / 1000);

        if (secondsElapsed < 30) {
          return res.status(400).json({
            success: false,
            message: `${staffMember.firstName} already clocked in (${secondsElapsed}s ago). Wait ${30 - secondsElapsed}s before clocking out.`
          });
        }

        const durationMinutes = Math.round((now - checkInTime) / 60000);
        const hours = (durationMinutes / 60).toFixed(2);

        const logEntry = new StaffShiftLog({
          role: staffMember.role,
          id: staffMember.id,
          lastName: staffMember.lastName,
          firstName: staffMember.firstName,
          clockIn: getTime(checkInTime),
          clockOut: getTime(now),
          durationMinutes,
          hoursWorked: parseFloat(hours),
          date: getDate(now)
        });

        await logEntry.save();
        await ActiveStaffSession.deleteOne({ id: staffMember.id });

        return res.json({
          type: "STAFF",
          action: "CHECK_OUT",
          firstName: staffMember.firstName,
          lastName: staffMember.lastName,
          message: `Staff Clock-Out: ${staffMember.firstName} ${staffMember.lastName} (${hours} hrs worked).`,
          log: logEntry
        });
      } else {
        const session = new ActiveStaffSession({
          role: staffMember.role,
          id: staffMember.id,
          lastName: staffMember.lastName,
          firstName: staffMember.firstName,
          checkInTime: now
        });
        await session.save();

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

    // B. Student Scan Branch
    const student = await Student.findOne({ id: cleanId });
    if (student) {
      const activeSession = await ActiveStudentSession.findOne({ studentId: student.id });

      if (activeSession) {
        const checkInTime = new Date(activeSession.checkInTime);
        const secondsElapsed = Math.round((now - checkInTime) / 1000);

        if (secondsElapsed < 30) {
          return res.status(400).json({
            success: false,
            message: `${student.firstName} already checked in (${secondsElapsed}s ago). Wait ${30 - secondsElapsed}s before checking out.`
          });
        }

        const durationMinutes = Math.round((now - checkInTime) / 60000);

        const logEntry = new StudentAttendanceLog({
          subject: student.subject,
          studentId: student.id,
          lastName: student.lastName,
          firstName: student.firstName,
          checkIn: getTime(checkInTime),
          checkOut: getTime(now),
          durationMinutes,
          date: getDate(now)
        });

        await logEntry.save();
        await ActiveStudentSession.deleteOne({ studentId: student.id });

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
        const session = new ActiveStudentSession({
          subject: student.subject,
          studentId: student.id,
          lastName: student.lastName,
          firstName: student.firstName,
          parentPhone: student.parentPhone || '',
          seatNumber: seatNumber || "Unassigned",
          checkInTime: now,
          isReady: false
        });
        await session.save();

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

// --- 2. Manual Direct Check-Out Endpoints ---
app.post('/api/checkout', async (req, res) => {
  const { studentId } = req.body;
  const cleanId = String(studentId || '').trim();
  const now = new Date();

  try {
    const student = await Student.findOne({ id: cleanId });
    if (!student) {
      return res.status(404).json({ success: false, message: `Student ID "${cleanId}" not found.` });
    }

    const session = await ActiveStudentSession.findOne({ studentId: cleanId });
    const startTime = session ? new Date(session.checkInTime) : now;
    const durationMinutes = Math.round((now - startTime) / 60000);

    const logEntry = new StudentAttendanceLog({
      subject: student.subject,
      studentId: student.id,
      lastName: student.lastName,
      firstName: student.firstName,
      checkIn: session ? getTime(startTime) : getTime(now),
      checkOut: getTime(now),
      durationMinutes,
      date: getDate(now)
    });

    await logEntry.save();
    if (session) await ActiveStudentSession.deleteOne({ studentId: cleanId });

    res.json({
      success: true,
      message: `${student.firstName} ${student.lastName} checked out. Duration: ${durationMinutes} mins.`,
      log: logEntry
    });
  } catch (err) {
    console.error('Direct Checkout Error:', err);
    res.status(500).json({ success: false, message: 'Failed to process checkout.' });
  }
});

app.post('/api/staff-checkout', async (req, res) => {
  const { employeeId, customTime } = req.body;
  const cleanId = String(employeeId || '').trim();

  try {
    const employee = await Employee.findOne({ id: cleanId });
    if (!employee) {
      return res.status(404).json({ success: false, message: `Employee ID "${cleanId}" not found.` });
    }

    const session = await ActiveStaffSession.findOne({ id: cleanId });
    const startTime = session ? new Date(session.checkInTime) : new Date();

    let endTime = new Date();
    if (customTime && customTime.trim() !== '') {
      endTime = resolveClockOutDate(startTime, customTime);
      if (!endTime) {
        return res.status(400).json({
          success: false,
          message: 'Invalid time format. Use "5:30 PM", "17:30", or leave blank for current time.'
        });
      }
      if (endTime < startTime) {
        return res.status(400).json({
          success: false,
          message: `Departure time cannot be earlier than check-in time (${getTime(startTime)}).`
        });
      }
    }

    const durationMinutes = Math.round((endTime - startTime) / 60000);
    const hours = (durationMinutes / 60).toFixed(2);

    const logEntry = new StaffShiftLog({
      role: employee.role,
      id: employee.id,
      lastName: employee.lastName,
      firstName: employee.firstName,
      clockIn: getTime(startTime),
      clockOut: getTime(endTime),
      durationMinutes,
      hoursWorked: parseFloat(hours),
      date: getDate(startTime)
    });

    await logEntry.save();
    if (session) await ActiveStaffSession.deleteOne({ id: cleanId });

    res.json({
      success: true,
      message: `Staff Clock-Out: ${employee.firstName} ${employee.lastName} (${hours} hrs worked, ended at ${getTime(endTime)}).`,
      log: logEntry
    });
  } catch (err) {
    console.error('Staff Clockout Error:', err);
    res.status(500).json({ success: false, message: 'Failed to process staff clock out.' });
  }
});

// --- 3. Pickup & Lobby Board ---
app.post('/api/ready-pickup', async (req, res) => {
  const { studentId } = req.body;
  const cleanId = String(studentId || '').trim();

  try {
    const session = await ActiveStudentSession.findOne({ studentId: cleanId });
    if (!session) {
      return res.status(404).json({ success: false, message: "Student is not currently checked in." });
    }

    session.isReady = true;
    session.readyTime = getTime(new Date());
    await session.save();

    res.json({ success: true, message: `${session.firstName} ${session.lastName} marked READY FOR PICKUP!` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to mark student ready.' });
  }
});

app.get('/api/lobby-board', async (req, res) => {
  try {
    const active = await ActiveStudentSession.find();

    const studying = active.map(s => ({
      firstName: s.firstName,
      lastNameInitial: s.lastName ? s.lastName[0] + '.' : '',
      seatNumber: s.seatNumber,
      subject: s.subject
    }));

    const readyForPickup = active
      .filter(s => s.isReady)
      .map(s => ({
        studentId: s.studentId,
        firstName: s.firstName,
        lastName: s.lastName,
        seatNumber: s.seatNumber,
        readyTime: s.readyTime
      }));

    res.json({ studying, readyForPickup });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch lobby board." });
  }
});

// --- 4. Student Management ---
app.post('/api/students', async (req, res) => {
  let { subject, id, lastName, firstName, parentPhone, isNewRegistration } = req.body;

  if (!id || String(id).trim() === '') {
    id = await generateUniqueTempId();
  } else {
    id = String(id).trim();
    if (isNewRegistration) {
      const existingStudent = await Student.findOne({ id });
      if (existingStudent) {
        return res.status(400).json({
          success: false,
          message: `ID "${id}" is already assigned to ${existingStudent.firstName} ${existingStudent.lastName}.`
        });
      }
    }
  }

  try {
    const student = await Student.findOneAndUpdate(
      { id },
      {
        subject: subject || "Math",
        id,
        lastName: String(lastName || '').trim(),
        firstName: String(firstName || '').trim(),
        parentPhone: parentPhone || ""
      },
      { upsert: true, new: true }
    );
    res.json({ success: true, message: `Saved ${firstName} ${lastName} with ID ${id}!`, student });
  } catch (err) {
    console.error('Save Student Error:', err);
    res.status(500).json({ success: false, message: 'Failed to save student.' });
  }
});

app.put('/api/students/:id', async (req, res) => {
  const studentId = String(req.params.id || '').trim();
  const { firstName, lastName, subject, parentPhone, newId } = req.body;

  try {
    const targetId = newId && String(newId).trim() !== '' ? String(newId).trim() : studentId;

    if (targetId !== studentId) {
      const exists = await Student.findOne({ id: targetId });
      if (exists) {
        return res.status(400).json({
          success: false,
          message: `Cannot update ID: "${targetId}" is already registered to ${exists.firstName} ${exists.lastName}.`
        });
      }
    }

    const updatedStudent = await Student.findOneAndUpdate(
      { id: studentId },
      {
        id: targetId,
        firstName: String(firstName || '').trim(),
        lastName: String(lastName || '').trim(),
        subject: subject || 'Math',
        parentPhone: parentPhone || ''
      },
      { new: true }
    );

    if (!updatedStudent) {
      return res.status(404).json({ success: false, message: `Student ID "${studentId}" not found.` });
    }

    await ActiveStudentSession.updateMany(
      { studentId },
      {
        studentId: targetId,
        firstName: updatedStudent.firstName,
        lastName: updatedStudent.lastName,
        subject: updatedStudent.subject,
        parentPhone: updatedStudent.parentPhone
      }
    );

    res.json({ success: true, message: `Updated student ${updatedStudent.firstName} ${updatedStudent.lastName}!` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update student.' });
  }
});

app.delete('/api/students/:id', async (req, res) => {
  const studentId = String(req.params.id || '').trim();
  try {
    const deletedStudent = await Student.findOneAndDelete({ id: studentId });
    if (!deletedStudent) {
      return res.status(404).json({ success: false, message: `Student ID "${studentId}" not found.` });
    }
    await ActiveStudentSession.deleteMany({ studentId });
    res.json({ success: true, message: `Student ${deletedStudent.firstName} ${deletedStudent.lastName} removed.` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete student.' });
  }
});

app.get('/api/students-qr', async (req, res) => {
  const students = await Student.find().sort({ lastName: 1, firstName: 1 });
  const list = await Promise.all(students.map(async s => ({
    ...s.toObject(),
    qrCode: await QRCode.toDataURL(String(s.id))
  })));
  res.json(list);
});

// --- 5. Staff Management ---
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

app.put('/api/employees/:id', async (req, res) => {
  const employeeId = String(req.params.id || '').trim();
  const { firstName, lastName, role } = req.body;

  try {
    const updatedEmployee = await Employee.findOneAndUpdate(
      { id: employeeId },
      {
        firstName: String(firstName || '').trim(),
        lastName: String(lastName || '').trim(),
        role: role || 'Assistant'
      },
      { new: true }
    );

    if (!updatedEmployee) {
      return res.status(404).json({ success: false, message: `Employee ID "${employeeId}" not found.` });
    }

    await ActiveStaffSession.updateMany(
      { id: employeeId },
      {
        firstName: updatedEmployee.firstName,
        lastName: updatedEmployee.lastName,
        role: updatedEmployee.role
      }
    );

    res.json({ success: true, message: `Updated employee ${updatedEmployee.firstName} ${updatedEmployee.lastName}!` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update employee.' });
  }
});

app.delete('/api/employees/:id', async (req, res) => {
  const employeeId = String(req.params.id || '').trim();
  try {
    const deletedEmployee = await Employee.findOneAndDelete({ id: employeeId });
    if (!deletedEmployee) {
      return res.status(404).json({ success: false, message: `Employee ID "${employeeId}" not found.` });
    }
    await ActiveStaffSession.deleteMany({ id: employeeId });
    res.json({ success: true, message: `Employee ${deletedEmployee.firstName} ${deletedEmployee.lastName} removed.` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete employee.' });
  }
});

app.get('/api/employees-qr', async (req, res) => {
  const employees = await Employee.find().sort({ lastName: 1, firstName: 1 });
  const list = await Promise.all(employees.map(async e => ({
    ...e.toObject(),
    qrCode: await QRCode.toDataURL(String(e.id))
  })));
  res.json(list);
});

// --- 6. Active Session Lists & Payroll Summaries ---
app.get('/api/active-students', async (req, res) => {
  try {
    const active = await ActiveStudentSession.find().sort({ checkInTime: 1 });
    const now = new Date();

    const mapped = active.map(s => {
      const checkIn = new Date(s.checkInTime);
      return {
        studentId: s.studentId,
        firstName: s.firstName,
        lastName: s.lastName,
        subject: s.subject,
        seatNumber: s.seatNumber,
        parentPhone: s.parentPhone,
        isReady: s.isReady,
        checkInFormatted: getTime(checkIn),
        minutesInCenter: Math.round((now - checkIn) / 60000)
      };
    });

    res.json(mapped);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch active students." });
  }
});

app.get('/api/active-staff', async (req, res) => {
  try {
    const active = await ActiveStaffSession.find().sort({ checkInTime: 1 });
    const now = new Date();

    const mapped = active.map(s => {
      const checkIn = new Date(s.checkInTime);
      return {
        id: s.id,
        firstName: s.firstName,
        lastName: s.lastName,
        role: s.role,
        checkInFormatted: getTime(checkIn),
        minutesOnDuty: Math.round((now - checkIn) / 60000)
      };
    });

    res.json(mapped);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch active staff." });
  }
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

// --- 7. Shift & Attendance Log Audit Endpoints ---
app.get('/api/staff-shift-logs', async (req, res) => {
  const { employeeId } = req.query;
  try {
    const query = employeeId ? { id: employeeId } : {};
    const logs = await StaffShiftLog.find(query).sort({ date: -1, _id: -1 });
    res.json(logs);
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch shift logs.' });
  }
});

app.put('/api/staff-shift-logs/:id', async (req, res) => {
  const { id } = req.params;
  const { clockIn, clockOut, hoursWorked, date } = req.body;

  try {
    const hours = parseFloat(hoursWorked);
    if (isNaN(hours) || hours < 0) {
      return res.status(400).json({ success: false, message: 'Valid positive hours worked required.' });
    }
    const durationMinutes = Math.round(hours * 60);

    const updateFields = {
      durationMinutes,
      hoursWorked: parseFloat(hours.toFixed(2))
    };
    if (clockIn !== undefined) updateFields.clockIn = clockIn.trim();
    if (clockOut !== undefined) updateFields.clockOut = clockOut.trim();
    if (date !== undefined) updateFields.date = date.trim();

    const updatedLog = await StaffShiftLog.findByIdAndUpdate(id, updateFields, { new: true });
    if (!updatedLog) {
      return res.status(404).json({ success: false, message: 'Shift log not found.' });
    }

    res.json({ success: true, message: 'Shift log updated successfully.', log: updatedLog });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update shift log.' });
  }
});

app.delete('/api/staff-shift-logs/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const deletedLog = await StaffShiftLog.findByIdAndDelete(id);
    if (!deletedLog) {
      return res.status(404).json({ success: false, message: 'Shift log not found.' });
    }
    res.json({ success: true, message: 'Shift log deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete shift log.' });
  }
});

app.get('/api/student-attendance-logs', async (req, res) => {
  const { studentId, startDate, endDate, limit } = req.query;
  try {
    const query = {};
    if (studentId) query.studentId = String(studentId).trim();
    if (startDate && endDate) query.date = { $gte: startDate, $lte: endDate };
    else if (startDate) query.date = { $gte: startDate };
    else if (endDate) query.date = { $lte: endDate };

    const maxLimit = parseInt(limit, 10) || 150;
    const logs = await StudentAttendanceLog.find(query).sort({ date: -1, _id: -1 }).limit(maxLimit);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch attendance logs.' });
  }
});

app.put('/api/student-attendance-logs/:id', async (req, res) => {
  const { id } = req.params;
  const { checkIn, checkOut, durationMinutes, date, subject } = req.body;

  try {
    const updateFields = {};
    if (checkIn !== undefined) updateFields.checkIn = String(checkIn).trim();
    if (checkOut !== undefined) updateFields.checkOut = String(checkOut).trim();
    if (date !== undefined) updateFields.date = String(date).trim();
    if (subject !== undefined) updateFields.subject = String(subject).trim();

    if (durationMinutes !== undefined) {
      const mins = parseInt(durationMinutes, 10);
      if (isNaN(mins) || mins < 0) {
        return res.status(400).json({ success: false, message: 'Duration must be positive minutes.' });
      }
      updateFields.durationMinutes = mins;
    }

    const updatedLog = await StudentAttendanceLog.findByIdAndUpdate(id, updateFields, { new: true });
    if (!updatedLog) {
      return res.status(404).json({ success: false, message: 'Attendance log not found.' });
    }

    res.json({ success: true, message: 'Attendance log updated successfully.', log: updatedLog });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to update attendance log.' });
  }
});

app.delete('/api/student-attendance-logs/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const deletedLog = await StudentAttendanceLog.findByIdAndDelete(id);
    if (!deletedLog) {
      return res.status(404).json({ success: false, message: 'Attendance log not found.' });
    }
    res.json({ success: true, message: 'Attendance log deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete attendance log.' });
  }
});

// --- 8. Book Library Operations ---
app.get('/api/books/generate-id', async (req, res) => {
  const { level } = req.query;
  const bookId = await generateUniqueBookId(level || 'GEN');
  res.json({ bookId });
});

app.get('/api/books-qr', async (req, res) => {
  try {
    const books = await Book.find().sort({ level: 1, bookNumber: 1, title: 1 });
    const list = await Promise.all(books.map(async b => ({
      ...b.toObject(),
      qrCode: await QRCode.toDataURL(String(b.bookId))
    })));
    res.json(list);
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch book barcodes.' });
  }
});

app.post('/api/books', async (req, res) => {
  let { bookId, title, author, level, bookNumber } = req.body;

  if (!title || !title.trim()) {
    return res.status(400).json({ success: false, message: 'Book title is required.' });
  }

  if (!bookId || !bookId.trim()) {
    bookId = await generateUniqueBookId(level || 'GEN');
  } else {
    bookId = String(bookId).trim();
  }

  try {
    const book = await Book.findOneAndUpdate(
      { bookId },
      {
        bookId,
        id: bookId, // Mirror to satisfy any stale legacy unique index
        title: String(title).trim(),
        author: String(author || '').trim(),
        level: String(level || 'General').trim(),
        bookNumber: String(bookNumber || '').trim()
      },
      { upsert: true, new: true, runValidators: true }
    );
    res.json({ success: true, message: `Saved "${book.title}" (${book.bookId})!`, book });
  } catch (err) {
    console.error('Save Book Error:', err);
    res.status(500).json({ 
      success: false, 
      message: err.code === 11000 
        ? `Duplicate ID "${bookId}". Please generate a fresh identifier.` 
        : (err.message || 'Failed to save book.') 
    });
  }
});

app.delete('/api/books/:id', async (req, res) => {
  try {
    await Book.findOneAndDelete({ bookId: req.params.id });
    res.json({ success: true, message: 'Book deleted from inventory.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to delete book.' });
  }
});

app.post('/api/books/scan', async (req, res) => {
  const { barcode, studentId } = req.body;
  const cleanBookId = String(barcode || '').trim();
  const cleanStudentId = String(studentId || '').trim();

  try {
    const book = await Book.findOne({ bookId: cleanBookId });
    if (!book) {
      return res.status(404).json({ success: false, message: `Book barcode "${cleanBookId}" not registered.` });
    }

    // Return flow
    if (book.status === 'CHECKED_OUT') {
      const checkoutTime = book.checkoutTime ? new Date(book.checkoutTime) : new Date();
      const daysOut = Math.max(1, Math.round((new Date() - checkoutTime) / (1000 * 60 * 60 * 24)));

      const log = new BookLog({
        bookId: book.bookId,
        title: book.title,
        author: book.author,
        level: book.level,
        bookNumber: book.bookNumber,
        studentId: book.currentHolderId,
        studentName: book.currentHolderName,
        parentPhone: book.parentPhone || '',
        checkoutDate: book.checkoutDate,
        returnDate: getDate(),
        daysOut
      });
      await log.save();

      const previousHolder = book.currentHolderName;
      book.status = 'AVAILABLE';
      book.currentHolderId = null;
      book.currentHolderName = null;
      book.parentPhone = '';
      book.checkoutDate = null;
      book.checkoutTime = null;
      await book.save();

      return res.json({
        success: true,
        action: 'RETURNED',
        message: `Returned "${book.title}". Checked back in from ${previousHolder} (${daysOut} day${daysOut > 1 ? 's' : ''} out).`
      });
    }

    // Checkout flow
    if (!cleanStudentId) {
      return res.status(200).json({
        success: false,
        action: 'NEED_STUDENT',
        bookTitle: book.title,
        message: `"${book.title}" is available. Please select or scan a Student ID to check it out.`
      });
    }

    const student = await Student.findOne({ id: cleanStudentId });
    if (!student) {
      return res.status(404).json({ success: false, message: `Student ID "${cleanStudentId}" not found.` });
    }

    book.status = 'CHECKED_OUT';
    book.currentHolderId = student.id;
    book.currentHolderName = `${student.firstName} ${student.lastName}`.trim();
    book.parentPhone = student.parentPhone || '';
    book.checkoutDate = getDate();
    book.checkoutTime = new Date();
    await book.save();

    return res.json({
      success: true,
      action: 'CHECKED_OUT',
      message: `Checked out "${book.title}" to ${book.currentHolderName} (${student.id}).`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error processing book scan.' });
  }
});

// --- 9. CSV Uploads ---
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

app.post('/api/upload-books', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

  const results = [];
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on('data', (row) => {
      const title = row.title || row.Title || row['Book Title'] || '';
      const author = row.author || row.Author || '';
      const level = row.level || row.Level || 'General';
      const bookNumber = row.bookNumber || row.Number || row['Book Number'] || row['#'] || '';
      const bookId = row.bookId || row.ID || row['Book ID'] || row.Barcode || '';

      if (String(title).trim()) {
        results.push({
          title: String(title).trim(),
          author: String(author).trim(),
          level: String(level).trim(),
          bookNumber: String(bookNumber).trim(),
          bookId: bookId ? String(bookId).trim() : null
        });
      }
    })
    .on('end', async () => {
      try {
        const operations = [];

        for (const item of results) {
          let finalId = item.bookId;
          if (!finalId) {
            finalId = await generateUniqueBookId(item.level);
          }

          operations.push({
            updateOne: {
              filter: { bookId: finalId },
              update: {
                $set: {
                  bookId: finalId,
                  id: finalId,
                  title: item.title,
                  author: item.author,
                  level: item.level,
                  bookNumber: item.bookNumber
                }
              },
              upsert: true
            }
          });
        }

        if (operations.length > 0) {
          await Book.bulkWrite(operations);
        }

        fs.unlinkSync(req.file.path);
        res.json({ success: true, message: `Successfully imported ${results.length} books into the library!` });
      } catch (err) {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ success: false, message: 'Failed to process book CSV upload.' });
      }
    });
});

// --- 10. Filtered CSV Exports ---
app.get('/api/export/student-logs', async (req, res) => {
  const { startDate, endDate } = req.query;

  try {
    const query = {};
    if (startDate && endDate) query.date = { $gte: startDate, $lte: endDate };
    else if (startDate) query.date = { $gte: startDate };
    else if (endDate) query.date = { $lte: endDate };

    const logs = await StudentAttendanceLog.find(query).sort({ date: -1, _id: -1 });

    const headers = ['Date', 'Student ID', 'First Name', 'Last Name', 'Subject', 'Check In', 'Check Out', 'Duration (Mins)'];
    const rows = logs.map(l => [
      `"${l.date || ''}"`,
      `"${l.studentId || ''}"`,
      `"${(l.firstName || '').replace(/"/g, '""')}"`,
      `"${(l.lastName || '').replace(/"/g, '""')}"`,
      `"${l.subject || ''}"`,
      `"${l.checkIn || ''}"`,
      `"${l.checkOut || ''}"`,
      l.durationMinutes || 0
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
    const filenameRange = startDate && endDate ? `${startDate}_to_${endDate}` : getDate();

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="student_attendance_${filenameRange}.csv"`);
    res.status(200).send(csvContent);
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to export student logs.' });
  }
});

app.get('/api/export/staff-logs', async (req, res) => {
  const { startDate, endDate } = req.query;

  try {
    const query = {};
    if (startDate && endDate) query.date = { $gte: startDate, $lte: endDate };
    else if (startDate) query.date = { $gte: startDate };
    else if (endDate) query.date = { $lte: endDate };

    const logs = await StaffShiftLog.find(query).sort({ date: -1, _id: -1 });

    const headers = ['Date', 'Employee ID', 'First Name', 'Last Name', 'Role', 'Clock In', 'Clock Out', 'Duration (Mins)', 'Hours Worked'];
    const rows = logs.map(l => [
      `"${l.date || ''}"`,
      `"${l.id || ''}"`,
      `"${(l.firstName || '').replace(/"/g, '""')}"`,
      `"${(l.lastName || '').replace(/"/g, '""')}"`,
      `"${l.role || ''}"`,
      `"${l.clockIn || ''}"`,
      `"${l.clockOut || ''}"`,
      l.durationMinutes || 0,
      l.hoursWorked || 0
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
    const filenameRange = startDate && endDate ? `${startDate}_to_${endDate}` : getDate();

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="staff_payroll_${filenameRange}.csv"`);
    res.status(200).send(csvContent);
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to export staff logs.' });
  }
});

app.get('/api/export/book-inventory', async (req, res) => {
  try {
    const books = await Book.find().sort({ level: 1, bookNumber: 1, title: 1 });
    const headers = ['Book ID', 'Title', 'Author', 'Level', 'Book Number', 'Status', 'Current Holder Name', 'Student ID', 'Parent Phone', 'Date Checked Out'];
    
    const rows = books.map(b => [
      `"${b.bookId || ''}"`,
      `"${(b.title || '').replace(/"/g, '""')}"`,
      `"${(b.author || '').replace(/"/g, '""')}"`,
      `"${b.level || ''}"`,
      `"${b.bookNumber || ''}"`,
      `"${b.status || 'AVAILABLE'}"`,
      `"${(b.currentHolderName || '').replace(/"/g, '""')}"`,
      `"${b.currentHolderId || ''}"`,
      `"${b.parentPhone || ''}"`,
      `"${b.checkoutDate || ''}"`
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="kumon_book_inventory_${getDate()}.csv"`);
    res.status(200).send(csvContent);
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to export book inventory.' });
  }
});

app.get('/api/export/book-history', async (req, res) => {
  const { startDate, endDate } = req.query;

  try {
    const query = {};
    if (startDate && endDate) query.returnDate = { $gte: startDate, $lte: endDate };
    else if (startDate) query.returnDate = { $gte: startDate };
    else if (endDate) query.returnDate = { $lte: endDate };

    const logs = await BookLog.find(query).sort({ returnDate: -1, _id: -1 });
    const headers = ['Date Returned', 'Date Checked Out', 'Days Borrowed', 'Book ID', 'Title', 'Author', 'Level', 'Book Number', 'Student Name', 'Student ID', 'Parent Phone'];

    const rows = logs.map(l => [
      `"${l.returnDate || ''}"`,
      `"${l.checkoutDate || ''}"`,
      l.daysOut || 0,
      `"${l.bookId || ''}"`,
      `"${(l.title || '').replace(/"/g, '""')}"`,
      `"${(l.author || '').replace(/"/g, '""')}"`,
      `"${l.level || ''}"`,
      `"${l.bookNumber || ''}"`,
      `"${(l.studentName || '').replace(/"/g, '""')}"`,
      `"${l.studentId || ''}"`,
      `"${l.parentPhone || ''}"`
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
    const filenameRange = startDate && endDate ? `${startDate}_to_${endDate}` : getDate();

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="book_borrow_history_${filenameRange}.csv"`);
    res.status(200).send(csvContent);
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to export borrow history.' });
  }
});

// --- 11. Stale Ghost Session Cleanup ---
async function cleanStaleSessions() {
  try {
    const active = await ActiveStudentSession.find();
    const now = new Date();

    for (const s of active) {
      const checkIn = new Date(s.checkInTime);
      const minutesElapsed = Math.round((now - checkIn) / 60000);

      if (minutesElapsed > 180) {
        const isDual = (s.subject || '').toLowerCase().includes('&');
        const defaultMinutes = isDual ? 60 : 45;

        const autoLog = new StudentAttendanceLog({
          subject: s.subject,
          studentId: s.studentId,
          lastName: s.lastName,
          firstName: s.firstName,
          checkIn: getTime(checkIn),
          checkOut: getTime(new Date(checkIn.getTime() + defaultMinutes * 60000)),
          durationMinutes: defaultMinutes,
          date: getDate(checkIn)
        });

        await autoLog.save();
        await ActiveStudentSession.deleteOne({ studentId: s.studentId });
        console.log(`[Auto-Clean] Cleared stale session for ${s.firstName} ${s.lastName} (capped at ${defaultMinutes}m).`);
      }
    }
  } catch (err) {
    console.error('Error during stale session cleanup:', err);
  }
}

setInterval(cleanStaleSessions, 15 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Kumon Check-In System running on port ${PORT}`));