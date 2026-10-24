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

const Student = mongoose.model('Student', studentSchema);
const Employee = mongoose.model('Employee', employeeSchema);
const StaffShiftLog = mongoose.model('StaffShiftLog', staffShiftLogSchema);
const StudentAttendanceLog = mongoose.model('StudentAttendanceLog', studentAttendanceLogSchema);

// In-Memory Live State
const activeStudentSessions = new Map();
const activeStaffSessions = new Map();
const readyForPickupList = [];

// --- 1. Kiosk Scan Endpoint ---
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
    console.error("Scan Error:", err);
    res.status(500).json({ success: false, message: err.message || "Database transaction error." });
  }
});

// --- 2. Pickup & Lobby Board ---
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

// --- 3. Student Management (Add, Get QR, Edit, Delete) ---
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

app.put('/api/students/:id', async (req, res) => {
  const studentId = String(req.params.id || '').trim();
  const { firstName, lastName, subject, parentPhone } = req.body;

  try {
    const updatedStudent = await Student.findOneAndUpdate(
      { id: studentId },
      {
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

    if (activeStudentSessions.has(studentId)) {
      const session = activeStudentSessions.get(studentId);
      session.firstName = updatedStudent.firstName;
      session.lastName = updatedStudent.lastName;
      session.subject = updatedStudent.subject;
      session.parentPhone = updatedStudent.parentPhone;
    }

    const pickupItem = readyForPickupList.find(p => p.studentId === studentId);
    if (pickupItem) {
      pickupItem.firstName = updatedStudent.firstName;
      pickupItem.lastName = updatedStudent.lastName;
    }

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
    if (activeStudentSessions.has(studentId)) activeStudentSessions.delete(studentId);
    const pIdx = readyForPickupList.findIndex(p => p.studentId === studentId);
    if (pIdx >= 0) readyForPickupList.splice(pIdx, 1);

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

// --- 4. Employee Management (Add, Get QR, Edit, Delete) ---
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

    if (activeStaffSessions.has(employeeId)) {
      const session = activeStaffSessions.get(employeeId);
      session.firstName = updatedEmployee.firstName;
      session.lastName = updatedEmployee.lastName;
      session.role = updatedEmployee.role;
    }

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
    if (activeStaffSessions.has(employeeId)) activeStaffSessions.delete(employeeId);
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

// --- 7. CSV Exports with Date Filtering ---
app.get('/api/export/student-logs', async (req, res) => {
  const { startDate, endDate } = req.query;

  try {
    const query = {};
    if (startDate && endDate) query.date = { $gte: startDate,$lte: endDate };
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
    if (startDate && endDate) query.date = { $gte: startDate,$lte: endDate };
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