const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('./config/database');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'schoolos_secret_key_123';

app.use(cors());
app.use(express.json());

// Grading Scale Helper
function getGrade(score) {
  if (score >= 75) return 'A';
  if (score >= 60) return 'B';
  if (score >= 50) return 'C';
  if (score >= 45) return 'D';
  if (score >= 40) return 'E';
  return 'F';
}

// ----------------------------------------------------
// 1. Auth Endpoints
// ----------------------------------------------------

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await query.get('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role, schoolId: user.school_id },
      JWT_SECRET,
      { expiresIn: '1d' }
    );

    // Get secondary details if student or teacher
    let profileDetails = {};
    if (user.role === 'student') {
      const student = await query.get('SELECT * FROM students WHERE user_id = ?', [user.id]);
      profileDetails = student || {};
    } else if (user.role === 'teacher') {
      const teacher = await query.get('SELECT * FROM teachers WHERE user_id = ?', [user.id]);
      profileDetails = teacher || {};
    }

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        phone: user.phone,
        address: user.address,
        ...profileDetails
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ----------------------------------------------------
// 2. School Info
// ----------------------------------------------------
app.get('/api/school/info', async (req, res) => {
  try {
    const school = await query.get('SELECT * FROM schools LIMIT 1');
    const session = await query.get('SELECT * FROM sessions WHERE active = 1');
    const term = await query.get('SELECT * FROM terms WHERE active = 1');

    res.json({
      school,
      session,
      term
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ----------------------------------------------------
// 3. Proprietor / Admin Overview Stats
// ----------------------------------------------------
app.get('/api/admin/overview', async (req, res) => {
  try {
    const totalStudents = await query.get('SELECT COUNT(*) as count FROM students');
    const totalTeachers = await query.get('SELECT COUNT(*) as count FROM teachers');
    const financialStats = await query.get(`
      SELECT 
        SUM(total_amount) as total_invoiced,
        SUM(paid_amount) as total_collected,
        SUM(total_amount - paid_amount) as outstanding_debt
      FROM invoices
    `);

    res.json({
      students: totalStudents.count,
      teachers: totalTeachers.count,
      invoiced: financialStats.total_invoiced || 0,
      collected: financialStats.total_collected || 0,
      debt: financialStats.outstanding_debt || 0
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ----------------------------------------------------
// 4. Student Management
// ----------------------------------------------------
app.get('/api/students', async (req, res) => {
  try {
    const students = await query.all(`
      SELECT s.id as student_id, u.id as user_id, u.name, u.email, u.phone, 
             c.name as class_name, c.id as class_id, s.admission_no, s.guardian_name, s.guardian_phone
      FROM students s
      JOIN users u ON s.user_id = u.id
      LEFT JOIN classes c ON s.class_id = c.id
    `);
    res.json(students);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/students', async (req, res) => {
  const { name, email, phone, class_id, guardian_name, guardian_phone } = req.body;

  try {
    const salt = await bcrypt.genSalt(10);
    const password = await bcrypt.hash('password123', salt); // default password
    const school = await query.get('SELECT id FROM schools LIMIT 1');

    // Create user
    const userResult = await query.run(`
      INSERT INTO users (school_id, name, email, password, role, phone)
      VALUES (?, ?, ?, ?, 'student', ?)
    `, [school.id, name, email, password, phone]);

    const user_id = userResult.id;
    const admission_no = 'ADM' + Date.now().toString().slice(-6);

    // Create student profile
    const studentResult = await query.run(`
      INSERT INTO students (user_id, class_id, admission_no, guardian_name, guardian_phone)
      VALUES (?, ?, ?, ?, ?)
    `, [user_id, class_id, admission_no, guardian_name, guardian_phone]);

    // Create invoice for default class fees
    const activeTerm = await query.get('SELECT t.id FROM terms t JOIN sessions s ON t.session_id = s.id WHERE t.active = 1 LIMIT 1');
    if (activeTerm) {
      const fees = await query.all('SELECT SUM(amount) as total FROM fee_structures WHERE class_id = ? AND term_id = ?', [class_id, activeTerm.id]);
      const totalAmount = fees[0].total || 0;

      if (totalAmount > 0) {
        await query.run(`
          INSERT INTO invoices (student_id, term_id, total_amount, paid_amount, status, due_date)
          VALUES (?, ?, ?, 0, 'unpaid', '2026-07-30')
        `, [studentResult.id, activeTerm.id, totalAmount]);
      }
    }

    res.status(201).json({ message: 'Student registered successfully', studentId: studentResult.id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error or email already exists' });
  }
});

// ----------------------------------------------------
// 5. Staff Management
// ----------------------------------------------------
app.get('/api/teachers', async (req, res) => {
  try {
    const teachers = await query.all(`
      SELECT t.id as teacher_id, u.id as user_id, u.name, u.email, u.phone, t.employee_no, t.department
      FROM teachers t
      JOIN users u ON t.user_id = u.id
    `);
    res.json(teachers);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ----------------------------------------------------
// 6. Academic Configurations (Classes, Subjects)
// ----------------------------------------------------
app.get('/api/classes', async (req, res) => {
  try {
    const classes = await query.all('SELECT * FROM classes');
    res.json(classes);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/classes', async (req, res) => {
  const { name, level } = req.body;
  try {
    const school = await query.get('SELECT id FROM schools LIMIT 1');
    const result = await query.run(`
      INSERT INTO classes (school_id, name, level) VALUES (?, ?, ?)
    `, [school.id, name, level]);
    res.status(201).json({ id: result.id, name, level });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/subjects', async (req, res) => {
  try {
    const subjects = await query.all('SELECT * FROM subjects');
    res.json(subjects);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/subjects', async (req, res) => {
  const { name, code } = req.body;
  try {
    const school = await query.get('SELECT id FROM schools LIMIT 1');
    const result = await query.run(`
      INSERT INTO subjects (school_id, name, code) VALUES (?, ?, ?)
    `, [school.id, name, code]);
    res.status(201).json({ id: result.id, name, code });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/teacher/classes/:teacherUserId', async (req, res) => {
  try {
    const classes = await query.all(`
      SELECT DISTINCT c.id as class_id, c.name as class_name, s.id as subject_id, s.name as subject_name
      FROM class_subjects cs
      JOIN classes c ON cs.class_id = c.id
      JOIN subjects s ON cs.subject_id = s.id
      WHERE cs.teacher_id = ?
    `, [req.params.teacherUserId]);
    res.json(classes);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ----------------------------------------------------
// 7. Results & Grade Processing Endpoints
// ----------------------------------------------------

// Fetch broadsheet scores for a class
app.get('/api/results/class/:classId/subject/:subjectId', async (req, res) => {
  const { classId, subjectId } = req.params;
  try {
    const activeTerm = await query.get('SELECT t.id FROM terms t JOIN sessions s ON t.session_id = s.id WHERE t.active = 1 LIMIT 1');
    if (!activeTerm) return res.status(404).json({ message: 'No active term found' });

    // Fetch all students in the class
    const students = await query.all(`
      SELECT s.id as student_id, u.name, s.admission_no
      FROM students s
      JOIN users u ON s.user_id = u.id
      WHERE s.class_id = ?
    `, [classId]);

    // Fetch existing scores for this term & subject
    const scores = await query.all(`
      SELECT r.student_id, r.ca_score, r.exam_score, r.total_score, r.grade, r.comment
      FROM results r
      WHERE r.term_id = ? AND r.subject_id = ?
    `, [activeTerm.id, subjectId]);

    const scoresMap = {};
    scores.forEach(s => {
      scoresMap[s.student_id] = s;
    });

    const studentScores = students.map(st => {
      const recorded = scoresMap[st.student_id] || { ca_score: '', exam_score: '', total_score: '', grade: '', comment: '' };
      return {
        student_id: st.student_id,
        name: st.name,
        admission_no: st.admission_no,
        ca_score: recorded.ca_score,
        exam_score: recorded.exam_score,
        total_score: recorded.total_score,
        grade: recorded.grade,
        comment: recorded.comment
      };
    });

    res.json(studentScores);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Record scores for students
app.post('/api/results/record', async (req, res) => {
  const { student_id, subject_id, ca_score, exam_score, comment } = req.body;
  const ca = parseFloat(ca_score) || 0;
  const exam = parseFloat(exam_score) || 0;
  const total = ca + exam;
  const grade = getGrade(total);

  try {
    const activeTerm = await query.get('SELECT t.id FROM terms t JOIN sessions s ON t.session_id = s.id WHERE t.active = 1 LIMIT 1');
    if (!activeTerm) return res.status(404).json({ message: 'No active term found' });

    await query.run(`
      INSERT INTO results (student_id, term_id, subject_id, ca_score, exam_score, total_score, grade, comment)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(student_id, term_id, subject_id) DO UPDATE SET
        ca_score = excluded.ca_score,
        exam_score = excluded.exam_score,
        total_score = excluded.total_score,
        grade = excluded.grade,
        comment = excluded.comment
    `, [student_id, activeTerm.id, subject_id, ca, exam, total, grade, comment]);

    res.json({ message: 'Result saved successfully', total, grade });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Report Card View: Get student performance, calculate averages, position rank
app.get('/api/results/student/:studentId', async (req, res) => {
  const { studentId } = req.params;

  try {
    const activeTerm = await query.get('SELECT t.id FROM terms t JOIN sessions s ON t.session_id = s.id WHERE t.active = 1 LIMIT 1');
    if (!activeTerm) return res.status(404).json({ message: 'No active term found' });

    const studentInfo = await query.get(`
      SELECT s.id as student_id, u.name as student_name, s.admission_no, c.name as class_name, c.id as class_id
      FROM students s
      JOIN users u ON s.user_id = u.id
      JOIN classes c ON s.class_id = c.id
      WHERE s.id = ?
    `, [studentId]);

    if (!studentInfo) return res.status(404).json({ message: 'Student not found' });

    // 1. Fetch academic results
    const results = await query.all(`
      SELECT sub.name as subject_name, sub.code as subject_code, r.ca_score, r.exam_score, r.total_score, r.grade, r.comment
      FROM results r
      JOIN subjects sub ON r.subject_id = sub.id
      WHERE r.student_id = ? AND r.term_id = ?
    `, [studentId, activeTerm.id]);

    // 2. Fetch class ranking
    // To rank, get sum of averages of all students in the class
    const allStudentsInClass = await query.all(`
      SELECT student_id, AVG(total_score) as avg_score, SUM(total_score) as total_sum
      FROM results
      WHERE term_id = ? AND student_id IN (
        SELECT id FROM students WHERE class_id = ?
      )
      GROUP BY student_id
      ORDER BY total_sum DESC
    `, [activeTerm.id, studentInfo.class_id]);

    let rank = '-';
    let classAverage = 0;
    let studentAverage = 0;

    if (allStudentsInClass.length > 0) {
      const rankIdx = allStudentsInClass.findIndex(s => s.student_id === parseInt(studentId));
      if (rankIdx !== -1) {
        rank = rankIdx + 1;
        studentAverage = allStudentsInClass[rankIdx].avg_score.toFixed(2);
      }
      const classAvgSum = allStudentsInClass.reduce((acc, curr) => acc + curr.avg_score, 0);
      classAverage = (classAvgSum / allStudentsInClass.length).toFixed(2);
    }

    // 3. Fetch attendance overview
    const attendanceLogs = await query.all('SELECT status FROM attendance WHERE student_id = ? AND term_id = ?', [studentId, activeTerm.id]);
    const totalDays = attendanceLogs.length;
    const daysPresent = attendanceLogs.filter(a => a.status === 'present').length;

    res.json({
      student: studentInfo,
      results,
      performance: {
        rank,
        classSize: allStudentsInClass.length,
        studentAverage,
        classAverage,
        daysPresent,
        totalDays
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ----------------------------------------------------
// 8. Financial Management (Bursar Endpoints)
// ----------------------------------------------------

app.get('/api/bursar/fees', async (req, res) => {
  try {
    const activeTerm = await query.get('SELECT t.id FROM terms t JOIN sessions s ON t.session_id = s.id WHERE t.active = 1 LIMIT 1');
    if (!activeTerm) return res.status(404).json({ message: 'No active term found' });

    const fees = await query.all(`
      SELECT f.*, c.name as class_name
      FROM fee_structures f
      JOIN classes c ON f.class_id = c.id
      WHERE f.term_id = ?
    `, [activeTerm.id]);
    res.json(fees);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/bursar/fees', async (req, res) => {
  const { class_id, fee_name, amount } = req.body;
  try {
    const activeTerm = await query.get('SELECT t.id FROM terms t JOIN sessions s ON t.session_id = s.id WHERE t.active = 1 LIMIT 1');
    if (!activeTerm) return res.status(404).json({ message: 'No active term' });

    const result = await query.run(`
      INSERT INTO fee_structures (class_id, term_id, fee_name, amount)
      VALUES (?, ?, ?, ?)
    `, [class_id, activeTerm.id, fee_name, amount]);

    res.status(201).json({ id: result.id, class_id, fee_name, amount });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/bursar/invoices', async (req, res) => {
  try {
    const invoices = await query.all(`
      SELECT i.*, u.name as student_name, s.admission_no, c.name as class_name
      FROM invoices i
      JOIN students s ON i.student_id = s.id
      JOIN users u ON s.user_id = u.id
      JOIN classes c ON s.class_id = c.id
    `);
    res.json(invoices);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/bursar/payments', async (req, res) => {
  const { invoice_id, amount_paid, payment_method } = req.body;
  const payVal = parseFloat(amount_paid) || 0;

  try {
    const invoice = await query.get('SELECT * FROM invoices WHERE id = ?', [invoice_id]);
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

    const newPaidAmount = invoice.paid_amount + payVal;
    let newStatus = 'unpaid';
    if (newPaidAmount >= invoice.total_amount) {
      newStatus = 'paid';
    } else if (newPaidAmount > 0) {
      newStatus = 'partial';
    }

    // Record payment
    const receiptNo = 'REC' + Date.now().toString().slice(-6);
    await query.run(`
      INSERT INTO payments (invoice_id, amount_paid, payment_date, payment_method, receipt_no)
      VALUES (?, ?, Date('now'), ?, ?)
    `, [invoice_id, payVal, payment_method, receiptNo]);

    // Update invoice
    await query.run(`
      UPDATE invoices
      SET paid_amount = ?, status = ?
      WHERE id = ?
    `, [newPaidAmount, newStatus, invoice_id]);

    res.json({ message: 'Payment recorded successfully', receiptNo });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ----------------------------------------------------
// 9. Parent Portal Endpoints
// ----------------------------------------------------
app.get('/api/parent/children/:parentUserId', async (req, res) => {
  try {
    const parent = await query.get('SELECT id FROM users WHERE id = ? AND role = "parent"', [req.params.parentUserId]);
    if (!parent) return res.status(404).json({ message: 'Parent user not found' });

    const children = await query.all(`
      SELECT s.id as student_id, u.name as child_name, s.admission_no, c.name as class_name, c.id as class_id
      FROM students s
      JOIN users u ON s.user_id = u.id
      JOIN classes c ON s.class_id = c.id
      WHERE s.parent_id = ?
    `, [req.params.parentUserId]);

    res.json(children);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get invoices for child
app.get('/api/parent/student/:studentId/invoices', async (req, res) => {
  try {
    const invoices = await query.all(`
      SELECT i.*, t.name as term_name
      FROM invoices i
      JOIN terms t ON i.term_id = t.id
      WHERE i.student_id = ?
    `, [req.params.studentId]);
    res.json(invoices);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ----------------------------------------------------
// Start Server
// ----------------------------------------------------
app.listen(PORT, () => {
  console.log(`SchoolOS AI Backend running on http://localhost:${PORT}`);
});
