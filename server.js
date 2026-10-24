const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const STUDENT_FILE = 'students.json';
const EMPLOYEE_FILE = 'employees.json';
const BOOK_FILE = 'books.json';
const SHIFT_LOG_FILE = 'staff_shift_logs.json';

function loadJSON(file) {
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (err) { return []; }
  }
  return [];
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

const students = loadJSON(STUDENT_FILE);
const employees = loadJSON(EMPLOYEE_FILE);
const books = loadJSON(BOOK_FILE);
const staffShiftLogs = loadJSON(SHIFT_LOG_FILE);

const activeStudentSessions = new Map();
const activeStaffSessions = new Map();
const checkedOutBooks = new Map();
const readyForPickupList = [];

const studentAttendanceLogs = [];
const bookLogs = [];

// 1. Unified Scan Route
app.post('/api/scan', (req, res) => {
  const { scanId, seatNumber } = req.body;
  const cleanId = String(scanId || '').trim();
  const now = new Date();

  // Check Staff Clock-In / Clock-Out
  const staffMember = employees.find(e => String(e.id).trim() === cleanId);
  if (staffMember) {
    if (activeStaffSessions.has(staffMember.id)) {
      const session = activeStaffSessions.get(staffMember.id);
      const durationMinutes = Math.round((now - session.checkInTime) / 60000);
      const hours = (durationMinutes / 60).toFixed(2);

      const logEntry = {
        role: staffMember.role,
        id: staffMember.id,
        lastName: staffMember.lastName,
        firstName: staffMember.firstName,
        clockIn: session.checkInTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        clockOut: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        durationMinutes,
        hoursWorked: parseFloat(hours),
        date: now.toISOString().split('T')[0]
      };

      staffShiftLogs.push(logEntry);
      saveJSON(SHIFT_LOG_FILE, staffShiftLogs);
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
  const student = students.find(s => String(s.id).trim() === cleanId);
  if (student) {
    if (activeStudentSessions.has(student.id)) {
      const session = activeStudentSessions.get(student.id);
      const durationMinutes = Math.round((now - session.checkInTime) / 60000);

      const logEntry = {
        subject: student.subject,
        studentId: student.id,
        lastName: student.lastName,
        firstName: student.firstName,
        checkIn: session.checkInTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        checkOut: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        durationMinutes,
        date: now.toISOString().split('T')[0]
      };

      studentAttendanceLogs.push(logEntry);
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
});

// 2. Mark Ready for Pickup
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

// 3. Lobby Board
app.get('/api/lobby-board', (req, res) => {
  const studying = Array.from(activeStudentSessions.values()).map(s => ({
    firstName: s.firstName,
    lastNameInitial: s.lastName ? s.lastName[0] + '.' : '',
    seatNumber: s.seatNumber,
    subject: s.subject
  }));

  res.json({ studying, readyForPickup: readyForPickupList });
});

// 4. Library Checkout / Return
app.post('/api/library/scan', (req, res) => {
  const { studentId, assetTag, newCondition } = req.body;
  const cleanAsset = String(assetTag || '').trim();
  const cleanStudent = String(studentId || '').trim();

  const bookCopy = books.find(b => String(b.assetTag).trim() === cleanAsset);
  if (!bookCopy) return res.status(404).json({ success: false, message: `Book Asset Tag "${cleanAsset}" not found.` });

  const now = new Date();

  if (checkedOutBooks.has(bookCopy.assetTag)) {
    const session = checkedOutBooks.get(bookCopy.assetTag);
    if (newCondition) bookCopy.condition = newCondition;

    const logEntry = {
      assetTag: bookCopy.assetTag,
      title: bookCopy.title,
      studentName: session.studentName,
      studentId: session.studentId,
      checkoutDate: session.checkoutDate,
      returnDate: now.toISOString().split('T')[0],
      condition: bookCopy.condition
    };

    bookLogs.push(logEntry);
    checkedOutBooks.delete(bookCopy.assetTag);
    saveJSON(BOOK_FILE, books);

    return res.json({ action: "RETURN", message: `Returned "${bookCopy.title}".`, log: logEntry });
  } else {
    const student = students.find(s => String(s.id).trim() === cleanStudent);
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
});

// 5. Payroll Summary
app.get('/api/payroll-summary', (req, res) => {
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
});

app.post('/api/reset-payroll', (req, res) => {
  staffShiftLogs.length = 0;
  saveJSON(SHIFT_LOG_FILE, staffShiftLogs);
  res.json({ success: true, message: "Payroll cycle reset successfully. New 2-week period started!" });
});

app.get('/api/export-payroll', (req, res) => {
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

  let csvContent = "Employee ID,Last Name,First Name,Role,Total Shifts,Total Minutes,Total Hours Worked\n";
  summaryMap.forEach(r => {
    csvContent += `"${r.id}","${r.lastName}","${r.firstName}","${r.role}","${r.totalShifts}","${r.totalMinutes}","${r.totalHours}"\n`;
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="Kumon_Payroll_Export.csv"');
  res.send(csvContent);
});

app.get('/api/export-attendance', (req, res) => {
  let csvContent = "Date,Type,Student/Staff ID,Last Name,First Name,Subject/Role,Check-In,Check-Out,Duration\n";

  studentAttendanceLogs.forEach(l => {
    csvContent += `"${l.date}","Student","${l.studentId}","${l.lastName}","${l.firstName}","${l.subject}","${l.checkIn}","${l.checkOut}","${l.durationMinutes} mins"\n`;
  });

  staffShiftLogs.forEach(l => {
    csvContent += `"${l.date}","Staff","${l.id}","${l.lastName}","${l.firstName}","${l.role}","${l.clockIn}","${l.clockOut}","${l.hoursWorked} hrs"\n`;
  });

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="Kumon_Attendance_Export.csv"');
  res.send(csvContent);
});

// Active Query Endpoints
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

app.post('/api/employees', (req, res) => {
  const { id, firstName, lastName, role } = req.body;
  employees.push({ id: String(id).trim(), firstName: String(firstName).trim(), lastName: String(lastName).trim(), role: role || "Assistant" });
  saveJSON(EMPLOYEE_FILE, employees);
  res.json({ success: true, message: `Added employee ${firstName} ${lastName}!` });
});

app.post('/api/students', (req, res) => {
  const { subject, id, lastName, firstName, parentPhone } = req.body;
  students.push({ subject: subject || "Math", id: String(id).trim(), lastName: String(lastName).trim(), firstName: String(firstName).trim(), parentPhone: parentPhone || "" });
  saveJSON(STUDENT_FILE, students);
  res.json({ success: true, message: `Added ${firstName} ${lastName} successfully!` });
});

app.get('/api/students-qr', async (req, res) => {
  const list = await Promise.all(students.map(async s => ({ ...s, qrCode: await QRCode.toDataURL(String(s.id)) })));
  res.json(list);
});

app.get('/api/employees-qr', async (req, res) => {
  const list = await Promise.all(employees.map(async e => ({ ...e, qrCode: await QRCode.toDataURL(String(e.id)) })));
  res.json(list);
});

app.get('/api/logs', (req, res) => {
  res.json({ studentLogs: studentAttendanceLogs, staffLogs: staffShiftLogs, bookLogs });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Kumon Check-In System running on port ${PORT}`));