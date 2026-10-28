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

// --- Persistent Active Session Schemas ---
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

const activeStaffSessionSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  firstName: String,
  lastName: String,
  role: { type: String, default: 'Assistant' },
  checkInTime: { type: Date, default: Date.now }
});

const Student = mongoose.model('Student', studentSchema);
const Employee = mongoose.model('Employee', employeeSchema);
const StaffShiftLog = mongoose.model('StaffShiftLog', staffShiftLogSchema);
const StudentAttendanceLog = mongoose.model('StudentAttendanceLog', studentAttendanceLogSchema);
const ActiveStudentSession = mongoose.model('ActiveStudentSession', activeStudentSessionSchema);
const ActiveStaffSession = mongoose.model('ActiveStaffSession', activeStaffSessionSchema);

// --- 1. Kiosk Scan Endpoint ---
app.post('/api/scan', async (req, res) => {
  const { scanId, seatNumber } = req.body;
  const cleanId = String(scanId || '').trim();
  const now = new Date();

  try {
    // Check Staff Clock-In / Clock-Out
    const staffMember = await Employee.findOne({ id: cleanId });
    if (staffMember) {
      const activeSession = await ActiveStaffSession.findOne({ id: staffMember.id });

      if (activeSession) {
        const checkInTime = new Date(activeSession.checkInTime);
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

    // Check Student Check-In / Check-Out
    const student = await Student.findOne({ id: cleanId });
    if (student) {
      const activeSession = await ActiveStudentSession.findOne({ studentId: student.id });

      if (activeSession) {
        const checkInTime = new Date(activeSession.checkInTime);
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
  const { employeeId } = req.body;
  const cleanId = String(employeeId || '').trim();
  const now = new Date();

  try {
    const employee = await Employee.findOne({ id: cleanId });
    if (!employee) {
      return res.status(404).json({ success: false, message: `Employee ID "${cleanId}" not found.` });
    }

    const session = await ActiveStaffSession.findOne({ id: cleanId });
    const startTime = session ? new Date(session.checkInTime) : now;
    const durationMinutes = Math.round((now - startTime) / 60000);
    const hours = (durationMinutes / 60).toFixed(2);

    const logEntry = new StaffShiftLog({
      role: employee.role,
      id: employee.id,
      lastName: employee.lastName,
      firstName: employee.firstName,
      clockIn: session ? getTime(startTime) : getTime(now),
      clockOut: getTime(now),
      durationMinutes,
      hoursWorked: parseFloat(hours),
      date: getDate(now)
    });

    await logEntry.save();
    if (session) await ActiveStaffSession.deleteOne({ id: cleanId });

    res.json({
      success: true,
      message: `Staff Clock-Out: ${employee.firstName} ${employee.lastName} (${hours} hrs worked).`,
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

// --- 4. Student Management (Add, QR, Edit, Delete, Temp IDs) ---
app.post('/api/students', async (req, res) => {
  let { subject, id, lastName, firstName, parentPhone } = req.body;

  if (!id || String(id).trim() === '') {
    id = `TEMP-${Math.floor(100000 + Math.random() * 900000)}`;
  } else {
    id = String(id).trim();
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

    // Keep active session in sync if student info changes while in center
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

// --- 5. Employee Management (Add, QR, Edit, Delete) ---
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

// --- 6. CSV Bulk Upload ---
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

// --- 7. Dashboards & Payroll (Reading from MongoDB) ---
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

// --- 8. Filtered CSV Exports ---
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Kumon Check-In System running on port ${PORT}`));