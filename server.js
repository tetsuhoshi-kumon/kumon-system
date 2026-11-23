const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const mongoose = require('mongoose');

const app = express();
app.get('/favicon.ico', (req, res) => res.status(204).end());
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

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
        }
      }
    } catch (idxErr) {}
  })
  .catch(err => console.error('MongoDB connection error:', err));

const studentSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  firstName: String,
  lastName: String,
  subject: { type: String, default: 'Math' },
  parentPhone: String,
  center: { type: String, default: 'Thousand Oaks' },
  createdAt: { type: Date, default: Date.now }
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

const bookSchema = new mongoose.Schema({
  bookId: { type: String, required: true, unique: true },
  id: { type: String },
  title: { type: String, required: true },
  author: { type: String, default: '' },
  level: { type: String, default: 'General' },
  bookNumber: { type: String, default: '' },
  status: { type: String, enum: ['AVAILABLE', 'CHECKED_OUT'], default: 'AVAILABLE' },
  currentHolderId: { type: String, default: null },
  currentHolderName: { type: String, default: null },
  parentPhone: { type: String, default: '' },
  checkoutDate: { type: String, default: null },
  checkoutTime: { type: Date, default: null },
  center: { type: String, default: 'Thousand Oaks' }
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

app.post('/api/scan', async (req, res) => {
  const { scanId, seatNumber } = req.body;
  const cleanId = String(scanId || '').trim();
  const now = new Date();

  try {
    const staffMember = await Employee.findOne({ id: cleanId });
    if (staffMember) {
      const activeSession = await ActiveStaffSession.findOne({ id: staffMember.id });
      if (activeSession) {
        const checkInTime = new Date(activeSession.checkInTime);
        const secondsElapsed = Math.round((now - checkInTime) / 1000);
        if (secondsElapsed < 30) {
          return res.status(400).json({ success: false, message: `${staffMember.firstName} already clocked in (${secondsElapsed}s ago). Wait ${30 - secondsElapsed}s.` });
        }
        const durationMinutes = Math.round((now - checkInTime) / 60000);
        const hours = (durationMinutes / 60).toFixed(2);
        const logEntry = new StaffShiftLog({ role: staffMember.role, id: staffMember.id, lastName: staffMember.lastName, firstName: staffMember.firstName, clockIn: getTime(checkInTime), clockOut: getTime(now), durationMinutes, hoursWorked: parseFloat(hours), date: getDate(now) });
        await logEntry.save();
        await ActiveStaffSession.deleteOne({ id: staffMember.id });
        return res.json({ type: "STAFF", action: "CHECK_OUT", firstName: staffMember.firstName, lastName: staffMember.lastName, message: `Staff Clock-Out: ${staffMember.firstName} ${staffMember.lastName} (${hours} hrs worked).`, log: logEntry });
      } else {
        const session = new ActiveStaffSession({ role: staffMember.role, id: staffMember.id, lastName: staffMember.lastName, firstName: staffMember.firstName, checkInTime: now });
        await session.save();
        return res.json({ type: "STAFF", action: "CHECK_IN", firstName: staffMember.firstName, lastName: staffMember.lastName, message: `Staff Clock-In: ${staffMember.firstName} ${staffMember.lastName} (${staffMember.role}).`, session });
      }
    }

    const student = await Student.findOne({ id: cleanId });
    if (student) {
      const activeSession = await ActiveStudentSession.findOne({ studentId: student.id });
      if (activeSession) {
        const checkInTime = new Date(activeSession.checkInTime);
        const secondsElapsed = Math.round((now - checkInTime) / 1000);
        if (secondsElapsed < 30) {
          return res.status(400).json({ success: false, message: `${student.firstName} already checked in (${secondsElapsed}s ago). Wait ${30 - secondsElapsed}s.` });
        }
        const durationMinutes = Math.round((now - checkInTime) / 60000);
        const logEntry = new StudentAttendanceLog({ subject: student.subject, studentId: student.id, lastName: student.lastName, firstName: student.firstName, checkIn: getTime(checkInTime), checkOut: getTime(now), durationMinutes, date: getDate(now) });
        await logEntry.save();
        await ActiveStudentSession.deleteOne({ studentId: student.id });
        return res.json({ type: "STUDENT", action: "CHECK_OUT", firstName: student.firstName, lastName: student.lastName, subject: student.subject, message: `${student.firstName} ${student.lastName} checked out. Time in center: ${durationMinutes} mins.`, log: logEntry });
      } else {
        const session = new ActiveStudentSession({ subject: student.subject, studentId: student.id, lastName: student.lastName, firstName: student.firstName, parentPhone: student.parentPhone || '', seatNumber: seatNumber || "Unassigned", checkInTime: now, isReady: false });
        await session.save();
        return res.json({ type: "STUDENT", action: "CHECK_IN", firstName: student.firstName, lastName: student.lastName, subject: student.subject, seatNumber: session.seatNumber, message: `${student.firstName} ${student.lastName} checked in!`, session });
      }
    }
    return res.status(404).json({ success: false, message: `Scanned ID "${cleanId}" not recognized as Student or Staff.` });
  } catch (err) { res.status(500).json({ success: false, message: err.message || "Database error." }); }
});

app.post('/api/checkout', async (req, res) => {
  const { studentId } = req.body;
  const cleanId = String(studentId || '').trim();
  const now = new Date();
  try {
    const student = await Student.findOne({ id: cleanId });
    if (!student) return res.status(404).json({ success: false, message: `Student ID "${cleanId}" not found.` });
    const session = await ActiveStudentSession.findOne({ studentId: cleanId });
    const startTime = session ? new Date(session.checkInTime) : now;
    const durationMinutes = Math.round((now - startTime) / 60000);
    const logEntry = new StudentAttendanceLog({ subject: student.subject, studentId: student.id, lastName: student.lastName, firstName: student.firstName, checkIn: session ? getTime(startTime) : getTime(now), checkOut: getTime(now), durationMinutes, date: getDate(now) });
    await logEntry.save();
    if (session) await ActiveStudentSession.deleteOne({ studentId: cleanId });
    res.json({ success: true, message: `${student.firstName} ${student.lastName} checked out. Duration: ${durationMinutes} mins.`, log: logEntry });
  } catch (err) { res.status(500).json({ success: false, message: 'Failed to process checkout.' }); }
});

app.post('/api/staff-checkout', async (req, res) => {
  const { employeeId, customTime } = req.body;
  const cleanId = String(employeeId || '').trim();
  try {
    const employee = await Employee.findOne({ id: cleanId });
    if (!employee) return res.status(404).json({ success: false, message: `Employee ID "${cleanId}" not found.` });
    const session = await ActiveStaffSession.findOne({ id: cleanId });
    const startTime = session ? new Date(session.checkInTime) : new Date();
    let endTime = new Date();
    if (customTime && customTime.trim() !== '') {
      endTime = resolveClockOutDate(startTime, customTime);
      if (!endTime) return res.status(400).json({ success: false, message: 'Invalid time format.' });
      if (endTime < startTime) return res.status(400).json({ success: false, message: `Departure time cannot be earlier than check-in time.` });
    }
    const durationMinutes = Math.round((endTime - startTime) / 60000);
    const hours = (durationMinutes / 60).toFixed(2);
    const logEntry = new StaffShiftLog({ role: employee.role, id: employee.id, lastName: employee.lastName, firstName: employee.firstName, clockIn: getTime(startTime), clockOut: getTime(endTime), durationMinutes, hoursWorked: parseFloat(hours), date: getDate(startTime) });
    await logEntry.save();
    if (session) await ActiveStaffSession.deleteOne({ id: cleanId });
    res.json({ success: true, message: `Staff Clock-Out: ${employee.firstName} ${employee.lastName} (${hours} hrs worked).`, log: logEntry });
  } catch (err) { res.status(500).json({ success: false, message: 'Failed to process staff clock out.' }); }
});

app.post('/api/ready-pickup', async (req, res) => {
  const { studentId } = req.body;
  try {
    const session = await ActiveStudentSession.findOne({ studentId: String(studentId || '').trim() });
    if (!session) return res.status(404).json({ success: false, message: "Student is not checked in." });
    session.isReady = true; session.readyTime = getTime(new Date()); await session.save();
    res.json({ success: true, message: `${session.firstName} ${session.lastName} marked READY FOR PICKUP!` });
  } catch (err) { res.status(500).json({ success: false, message: 'Failed.' }); }
});

app.get('/api/lobby-board', async (req, res) => {
  try {
    const active = await ActiveStudentSession.find();
    const studying = active.map(s => ({ firstName: s.firstName, lastNameInitial: s.lastName ? s.lastName[0] + '.' : '', seatNumber: s.seatNumber, subject: s.subject }));
    const readyForPickup = active.filter(s => s.isReady).map(s => ({ studentId: s.studentId, firstName: s.firstName, lastName: s.lastName, seatNumber: s.seatNumber, readyTime: s.readyTime }));
    res.json({ studying, readyForPickup });
  } catch (err) { res.status(500).json({ error: "Failed to fetch lobby board." }); }
});

app.post('/api/students', async (req, res) => {
  let { subject, id, lastName, firstName, parentPhone, isNewRegistration } = req.body;
  if (!id || String(id).trim() === '') id = await generateUniqueTempId();
  else id = String(id).trim();
  try {
    const student = await Student.findOneAndUpdate({ id }, { subject: subject || "Math", id, lastName: String(lastName || '').trim(), firstName: String(firstName || '').trim(), parentPhone: parentPhone || "" }, { upsert: true, new: true });
    res.json({ success: true, message: `Saved ${firstName} ${lastName}!`, student });
  } catch (err) { res.status(500).json({ success: false, message: 'Failed.' }); }
});

app.put('/api/students/:id', async (req, res) => {
  try {
    const targetId = req.body.newId ? String(req.body.newId).trim() : String(req.params.id);
    const updatedStudent = await Student.findOneAndUpdate({ id: String(req.params.id).trim() }, { id: targetId, firstName: String(req.body.firstName || '').trim(), lastName: String(req.body.lastName || '').trim(), subject: req.body.subject || 'Math', parentPhone: req.body.parentPhone || '' }, { new: true });
    await ActiveStudentSession.updateMany({ studentId: String(req.params.id) }, { studentId: targetId, firstName: updatedStudent.firstName, lastName: updatedStudent.lastName, subject: updatedStudent.subject, parentPhone: updatedStudent.parentPhone });
    res.json({ success: true, message: `Updated student!` });
  } catch (err) { res.status(500).json({ success: false, message: 'Failed.' }); }
});

app.delete('/api/students/:id', async (req, res) => {
  try {
    await Student.findOneAndDelete({ id: String(req.params.id).trim() });
    await ActiveStudentSession.deleteMany({ studentId: String(req.params.id).trim() });
    res.json({ success: true, message: `Student removed.` });
  } catch (err) { res.status(500).json({ success: false, message: 'Failed.' }); }
});

app.get('/api/students-qr', async (req, res) => {
  const students = await Student.find().sort({ lastName: 1, firstName: 1 });
  const list = await Promise.all(students.map(async s => ({ ...s.toObject(), qrCode: await QRCode.toDataURL(String(s.id)) })));
  res.json(list);
});

app.get('/api/students/:id/book-history', async (req, res) => {
  try {
    const studentId = String(req.params.id || '').trim();
    const [currentlyOut, pastLogs] = await Promise.all([ Book.find({ currentHolderId: studentId }).sort({ checkoutDate: -1 }), BookLog.find({ studentId }).sort({ returnDate: -1, _id: -1 }).limit(30) ]);
    res.json({ currentlyOut, pastLogs });
  } catch (err) { res.status(500).json({ success: false, message: 'Failed.' }); }
});

app.post('/api/employees', async (req, res) => {
  try {
    const { id, firstName, lastName, role } = req.body;
    await Employee.findOneAndUpdate({ id: String(id).trim() }, { id: String(id).trim(), firstName: String(firstName || '').trim(), lastName: String(lastName || '').trim(), role: role || "Assistant" }, { upsert: true, new: true });
    res.json({ success: true, message: `Saved employee!` });
  } catch(e) { res.status(500).json({ success: false }); }
});

app.put('/api/employees/:id', async (req, res) => {
  try {
    const updatedEmployee = await Employee.findOneAndUpdate({ id: String(req.params.id).trim() }, { firstName: String(req.body.firstName || '').trim(), lastName: String(req.body.lastName || '').trim(), role: req.body.role || 'Assistant' }, { new: true });
    await ActiveStaffSession.updateMany({ id: req.params.id }, { firstName: updatedEmployee.firstName, lastName: updatedEmployee.lastName, role: updatedEmployee.role });
    res.json({ success: true, message: `Updated employee!` });
  } catch (err) { res.status(500).json({ success: false, message: 'Failed.' }); }
});

app.delete('/api/employees/:id', async (req, res) => {
  try {
    await Employee.findOneAndDelete({ id: String(req.params.id).trim() });
    await ActiveStaffSession.deleteMany({ id: String(req.params.id).trim() });
    res.json({ success: true, message: `Employee removed.` });
  } catch (err) { res.status(500).json({ success: false, message: 'Failed.' }); }
});

app.get('/api/employees-qr', async (req, res) => {
  const employees = await Employee.find().sort({ lastName: 1, firstName: 1 });
  const list = await Promise.all(employees.map(async e => ({ ...e.toObject(), qrCode: await QRCode.toDataURL(String(e.id)) })));
  res.json(list);
});

app.get('/api/active-students', async (req, res) => {
  try {
    const active = await ActiveStudentSession.find().sort({ checkInTime: 1 });
    const now = new Date();
    res.json(active.map(s => ({ ...s.toObject(), checkInFormatted: getTime(new Date(s.checkInTime)), minutesInCenter: Math.round((now - new Date(s.checkInTime)) / 60000) })));
  } catch (err) { res.status(500).json({ error: "Failed." }); }
});

app.get('/api/active-staff', async (req, res) => {
  try {
    const active = await ActiveStaffSession.find().sort({ checkInTime: 1 });
    const now = new Date();
    res.json(active.map(s => ({ ...s.toObject(), checkInFormatted: getTime(new Date(s.checkInTime)), minutesOnDuty: Math.round((now - new Date(s.checkInTime)) / 60000) })));
  } catch (err) { res.status(500).json({ error: "Failed." }); }
});

app.get('/api/payroll-summary', async (req, res) => {
  try {
    const employees = await Employee.find();
    const staffShiftLogs = await StaffShiftLog.find();
    const summaryMap = new Map();
    employees.forEach(emp => summaryMap.set(emp.id, { id: emp.id, firstName: emp.firstName, lastName: emp.lastName, role: emp.role, totalShifts: 0, totalMinutes: 0, totalHours: 0 }));
    staffShiftLogs.forEach(log => {
      if (summaryMap.has(log.id)) {
        const record = summaryMap.get(log.id);
        record.totalShifts += 1;
        record.totalMinutes += log.durationMinutes || 0;
        record.totalHours = (record.totalMinutes / 60).toFixed(2);
      }
    });
    res.json(Array.from(summaryMap.values()));
  } catch (err) { res.status(500).json({ error: "Failed." }); }
});

app.post('/api/reset-payroll', async (req, res) => { await StaffShiftLog.deleteMany({}); res.json({ success: true, message: "Reset." }); });

app.get('/api/staff-shift-logs', async (req, res) => {
  try { res.json(await StaffShiftLog.find(req.query.employeeId ? { id: req.query.employeeId } : {}).sort({ date: -1, _id: -1 })); } catch (err) { res.status(500).json({ success: false }); }
});

app.put('/api/staff-shift-logs/:id', async (req, res) => {
  try {
    const updateFields = { durationMinutes: Math.round(parseFloat(req.body.hoursWorked) * 60), hoursWorked: parseFloat(req.body.hoursWorked) };
    if (req.body.clockIn) updateFields.clockIn = req.body.clockIn.trim();
    if (req.body.clockOut) updateFields.clockOut = req.body.clockOut.trim();
    if (req.body.date) updateFields.date = req.body.date.trim();
    const updatedLog = await StaffShiftLog.findByIdAndUpdate(req.params.id, updateFields, { new: true });
    res.json({ success: true, log: updatedLog });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.delete('/api/staff-shift-logs/:id', async (req, res) => {
  try { await StaffShiftLog.findByIdAndDelete(req.params.id); res.json({ success: true }); } catch (err) { res.status(500).json({ success: false }); }
});

app.get('/api/student-attendance-logs', async (req, res) => {
  try {
    const { studentId, startDate, endDate, limit } = req.query;
    const query = {};
    if (studentId) query.studentId = String(studentId).trim();
    if (startDate && endDate) query.date = { $gte: startDate, $lte: endDate };
    res.json(await StudentAttendanceLog.find(query).sort({ date: -1, _id: -1 }).limit(parseInt(limit, 10) || 150));
  } catch (err) { res.status(500).json({ success: false }); }
});

app.put('/api/student-attendance-logs/:id', async (req, res) => {
  try {
    const updatedLog = await StudentAttendanceLog.findByIdAndUpdate(req.params.id, { ...req.body }, { new: true });
    res.json({ success: true, log: updatedLog });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.delete('/api/student-attendance-logs/:id', async (req, res) => {
  try { await StudentAttendanceLog.findByIdAndDelete(req.params.id); res.json({ success: true }); } catch (err) { res.status(500).json({ success: false }); }
});

app.get('/api/books/generate-id', async (req, res) => { res.json({ bookId: await generateUniqueBookId(req.query.level || 'GEN') }); });

app.get('/api/books-qr', async (req, res) => {
  try {
    const rawCenter = (req.query.center || 'all').trim();
    let filter = {};
    if (rawCenter.toLowerCase() === 'camarillo') filter = { center: { $regex: /^camarillo$/i } };
    else if (rawCenter.toLowerCase() === 'thousand oaks') filter = { $or: [{ center: { $regex: /^thousand oaks$/i } }, { center: { $exists: false } }, { center: null }, { center: '' }] };
    const books = await Book.find(filter).lean();
    const list = await Promise.all(books.map(async b => ({ ...b, center: b.center || 'Thousand Oaks', qrCode: await QRCode.toDataURL(String(b.bookId)) })));
    res.json(list);
  } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/api/books/bulk-center', async (req, res) => {
  try { await Book.updateMany({ bookId: { $in: req.body.bookIds } }, { $set: { center: String(req.body.center).trim() } }); res.json({ success: true, message: `Updated books!` }); } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/api/books/bulk-delete', async (req, res) => {
  try { await Book.deleteMany({ bookId: { $in: req.body.bookIds } }); res.json({ success: true, message: `Deleted books.` }); } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/api/books/delete-unassigned', async (req, res) => {
  try { await Book.deleteMany({ $or: [{ center: { $exists: false } }, { center: null }, { center: '' }] }); res.json({ success: true, message: `Deleted unassigned books!` }); } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/api/books/delete-all', async (req, res) => {
  try { await Book.deleteMany({}); res.json({ success: true, message: `Cleared library!` }); } catch (err) { res.status(500).json({ success: false }); }
});

// ==========================================
// CSV BOOK UPLOAD 
// ==========================================
app.post('/api/upload-books', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No CSV file uploaded.' });

  const results = [];
  const uiTargetCenter = (req.body.center || 'Thousand Oaks').trim();
  
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on('data', (data) => results.push(data))
    .on('end', async () => {
      let added = 0; let skipped = 0; let errors = 0; const addedBookIds = [];
      for (const row of results) {
        const title = row['Title'] || row['title'] || row['TITLE'] || '';
        const author = row['Author'] || row['author'] || row['AUTHOR'] || '';
        const level = row['Level'] || row['level'] || row['LEVEL'] || 'GEN';
        const bookNumber = row['Number'] || row['number'] || row['Book Number'] || row['Book #'] || '';
        let bookId = row['bookId'] || row['Book ID'] || row['Barcode'] || row['id'] || row['ID'] || '';
        const csvCenter = row['Center'] || row['center'] || row['CENTER'] || row['Location'] || '';
        const finalCenter = csvCenter ? String(csvCenter).trim() : uiTargetCenter;

        if (!title) { skipped++; continue; }

        try {
          if (!bookId) {
            let unique = false;
            const cleanLevel = String(level).replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 4) || 'GEN';
            while (!unique) {
              bookId = `BK-${cleanLevel}-${Date.now().toString(36).toUpperCase().slice(-4)}-${Math.floor(10 + Math.random() * 90)}`;
              if (!(await Book.findOne({ bookId }))) unique = true;
            }
          } else { bookId = String(bookId).trim(); }

          await Book.findOneAndUpdate({ bookId }, { bookId, title: String(title).trim(), author: String(author).trim(), level: String(level).trim(), bookNumber: String(bookNumber).trim(), center: finalCenter, createdAt: new Date() }, { upsert: true, new: true });
          addedBookIds.push(bookId);
          added++;
        } catch (dbErr) { errors++; }
      }
      try { fs.unlinkSync(req.file.path); } catch (fsErr) {}
      res.json({ success: true, addedBookIds, message: `CSV Processed! ${added} books saved. ${skipped > 0 ? skipped + ' skipped.' : ''} ${errors > 0 ? errors + ' errors.' : ''}` });
    })
    .on('error', (err) => res.status(500).json({ success: false, message: 'Failed to parse CSV.' }));
});

app.post('/api/books/scan', async (req, res) => {
  const { barcode, studentId } = req.body;
  try {
    const book = await Book.findOne({ bookId: String(barcode).trim() });
    if (!book) return res.status(404).json({ success: false, message: `Book barcode ${barcode} not found.` });

    if (book.status === 'AVAILABLE') {
      if (!studentId) return res.status(400).json({ success: false, message: 'Student name or ID required to check out.' });
      const cleanStudent = String(studentId).trim();
      const student = await Student.findOne({ id: cleanStudent });
      if (!student) return res.status(404).json({ success: false, message: `Student ${cleanStudent} not found.` });
      
      book.status = 'CHECKED_OUT';
      book.currentHolderId = student.id;
      book.currentHolderName = `${student.firstName} ${student.lastName}`;
      book.parentPhone = student.parentPhone || '';
      book.checkoutDate = getDate(new Date());
      book.checkoutTime = new Date();
      await book.save();
      return res.json({ success: true, message: `Checked out "${book.title}" to ${student.firstName}.` });
    } else {
      const log = new BookLog({
        bookId: book.bookId, title: book.title, author: book.author, level: book.level, bookNumber: book.bookNumber,
        studentId: book.currentHolderId, studentName: book.currentHolderName, parentPhone: book.parentPhone,
        checkoutDate: book.checkoutDate, returnDate: getDate(new Date()),
        daysOut: Math.max(0, Math.floor((new Date() - new Date(book.checkoutTime || new Date())) / 86400000))
      });
      await log.save();
      book.status = 'AVAILABLE'; book.currentHolderId = null; book.currentHolderName = null; book.parentPhone = ''; book.checkoutDate = null; book.checkoutTime = null;
      await book.save();
      return res.json({ success: true, message: `Returned "${book.title}".` });
    }
  } catch (err) { res.status(500).json({ success: false, message: 'Transaction failed.' }); }
});

app.post('/api/books', async (req, res) => {
  try {
    const cleanId = req.body.bookId && String(req.body.bookId).trim() !== ''
      ? String(req.body.bookId).trim()
      : await generateUniqueBookId(req.body.level || 'GEN');
    const b = new Book({ bookId: cleanId, title: req.body.title, author: req.body.author, level: req.body.level, bookNumber: req.body.bookNumber, center: req.body.center, createdAt: new Date() });
    await b.save();
    res.json({ success: true, book: b });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
app.delete('/api/books/:id', async (req, res) => {
  await Book.findOneAndDelete({ bookId: req.params.id }); res.json({ success: true });
});

// Extra analytics and export routes
app.get('/api/export/student-logs', async (req, res) => {
  try {
    const logs = await StudentAttendanceLog.find().sort({ date: -1 });
    const rows = logs.map(l => `"${l.date}","${l.studentId}","${l.firstName}","${l.lastName}","${l.subject}","${l.checkIn}","${l.checkOut}",${l.durationMinutes}`);
    res.header('Content-Type', 'text/csv').send(['Date,ID,First,Last,Subject,In,Out,Duration'].concat(rows).join('\n'));
  } catch (e) { res.status(500).send('Error'); }
});

app.get('/api/export/book-inventory', async (req, res) => {
  try {
    const books = await Book.find().sort({ level: 1 });
    const rows = books.map(b => `"${b.bookId}","${b.title}","${b.level}","${b.status}","${b.center}"`);
    res.header('Content-Type', 'text/csv').send(['ID,Title,Level,Status,Center'].concat(rows).join('\n'));
  } catch (e) { res.status(500).send('Error'); }
});

app.listen(process.env.PORT || 3000, () => console.log(`Kumon Server running`));
