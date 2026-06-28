const { query } = require('./database');
const bcrypt = require('bcryptjs');

async function seed() {
  console.log('Starting database initialization and seeding...');

  try {
    // 1. Create Tables
    console.log('Creating tables...');

    await query.exec(`
      CREATE TABLE IF NOT EXISTS schools (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        tagline TEXT,
        logo TEXT,
        address TEXT,
        phone TEXT
      );
    `);

    await query.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        school_id INTEGER,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT CHECK(role IN ('admin', 'principal', 'bursar', 'teacher', 'parent', 'student')),
        phone TEXT,
        address TEXT,
        active INTEGER DEFAULT 1,
        invitation_status TEXT DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (school_id) REFERENCES schools(id)
      );
    `);

    await query.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        school_id INTEGER,
        name TEXT NOT NULL,
        active INTEGER DEFAULT 0,
        FOREIGN KEY (school_id) REFERENCES schools(id)
      );
    `);

    await query.exec(`
      CREATE TABLE IF NOT EXISTS terms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER,
        name TEXT NOT NULL,
        active INTEGER DEFAULT 0,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
    `);

    await query.exec(`
      CREATE TABLE IF NOT EXISTS classes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        school_id INTEGER,
        name TEXT NOT NULL,
        level TEXT CHECK(level IN ('primary', 'secondary')),
        FOREIGN KEY (school_id) REFERENCES schools(id)
      );
    `);

    await query.exec(`
      CREATE TABLE IF NOT EXISTS subjects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        school_id INTEGER,
        name TEXT NOT NULL,
        code TEXT NOT NULL,
        FOREIGN KEY (school_id) REFERENCES schools(id)
      );
    `);

    await query.exec(`
      CREATE TABLE IF NOT EXISTS class_subjects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER,
        subject_id INTEGER,
        teacher_id INTEGER,
        FOREIGN KEY (class_id) REFERENCES classes(id),
        FOREIGN KEY (subject_id) REFERENCES subjects(id),
        FOREIGN KEY (teacher_id) REFERENCES users(id)
      );
    `);

    await query.exec(`
      CREATE TABLE IF NOT EXISTS students (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER UNIQUE,
        class_id INTEGER,
        parent_id INTEGER,
        admission_no TEXT UNIQUE NOT NULL,
        guardian_name TEXT,
        guardian_phone TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (class_id) REFERENCES classes(id),
        FOREIGN KEY (parent_id) REFERENCES users(id)
      );
    `);

    await query.exec(`
      CREATE TABLE IF NOT EXISTS teachers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER UNIQUE,
        employee_no TEXT UNIQUE NOT NULL,
        department TEXT,
        class_id INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (class_id) REFERENCES classes(id)
      );
    `);

    await query.exec(`
      CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER,
        term_id INTEGER,
        date TEXT NOT NULL,
        status TEXT CHECK(status IN ('present', 'absent')),
        remarks TEXT,
        FOREIGN KEY (student_id) REFERENCES students(id),
        FOREIGN KEY (term_id) REFERENCES terms(id)
      );
    `);

    await query.exec(`
      CREATE TABLE IF NOT EXISTS results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER,
        term_id INTEGER,
        subject_id INTEGER,
        ca_score REAL DEFAULT 0,
        exam_score REAL DEFAULT 0,
        total_score REAL DEFAULT 0,
        grade TEXT,
        comment TEXT,
        FOREIGN KEY (student_id) REFERENCES students(id),
        FOREIGN KEY (term_id) REFERENCES terms(id),
        FOREIGN KEY (subject_id) REFERENCES subjects(id),
        UNIQUE(student_id, term_id, subject_id)
      );
    `);

    await query.exec(`
      CREATE TABLE IF NOT EXISTS fee_structures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER,
        term_id INTEGER,
        fee_name TEXT NOT NULL,
        amount REAL NOT NULL,
        FOREIGN KEY (class_id) REFERENCES classes(id),
        FOREIGN KEY (term_id) REFERENCES terms(id)
      );
    `);

    await query.exec(`
      CREATE TABLE IF NOT EXISTS invoices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER,
        term_id INTEGER,
        total_amount REAL NOT NULL,
        paid_amount REAL DEFAULT 0,
        status TEXT CHECK(status IN ('unpaid', 'partial', 'paid')) DEFAULT 'unpaid',
        due_date TEXT,
        FOREIGN KEY (student_id) REFERENCES students(id),
        FOREIGN KEY (term_id) REFERENCES terms(id)
      );
    `);

    await query.exec(`
      CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_id INTEGER,
        amount_paid REAL NOT NULL,
        payment_date TEXT NOT NULL,
        payment_method TEXT,
        receipt_no TEXT UNIQUE,
        FOREIGN KEY (invoice_id) REFERENCES invoices(id)
      );
    `);

    console.log('Tables created successfully. Seeding data...');

    // 2. Clear Existing Data
    await query.run('DELETE FROM payments');
    await query.run('DELETE FROM invoices');
    await query.run('DELETE FROM fee_structures');
    await query.run('DELETE FROM results');
    await query.run('DELETE FROM attendance');
    await query.run('DELETE FROM teachers');
    await query.run('DELETE FROM students');
    await query.run('DELETE FROM class_subjects');
    await query.run('DELETE FROM subjects');
    await query.run('DELETE FROM classes');
    await query.run('DELETE FROM terms');
    await query.run('DELETE FROM sessions');
    await query.run('DELETE FROM users');
    await query.run('DELETE FROM schools');

    // 3. Insert School
    const school = await query.run(`
      INSERT INTO schools (name, tagline, logo, address, phone)
      VALUES (
        'Greenwood International Academy',
        'Nurturing Leaders of Tomorrow',
        'https://images.unsplash.com/photo-1546410531-bb4caa6b424d?w=150',
        '12 Alfred Rewane Road, Ikoyi, Lagos, Nigeria',
        '+234 1 234 5678'
      )
    `);
    const schoolId = school.id;

    // 4. Create Users (with hashed passwords)
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash('password123', salt);

    // Admin / Proprietor
    const adminUser = await query.run(`
      INSERT INTO users (school_id, name, email, password, role, phone, address)
      VALUES (?, 'Chief Abdul-Malik', 'admin@schoolos.com', ?, 'admin', '+2348030000001', 'Ikoyi, Lagos')
    `, [schoolId, hashedPassword]);

    // Principal
    const principalUser = await query.run(`
      INSERT INTO users (school_id, name, email, password, role, phone, address)
      VALUES (?, 'Mrs. Florence Nwosu', 'principal@schoolos.com', ?, 'principal', '+2348030000002', 'Lekki Phase 1, Lagos')
    `, [schoolId, hashedPassword]);

    // Bursar
    const bursarUser = await query.run(`
      INSERT INTO users (school_id, name, email, password, role, phone, address)
      VALUES (?, 'Mr. Dele Ojo', 'bursar@schoolos.com', ?, 'bursar', '+2348030000003', 'Surulere, Lagos')
    `, [schoolId, hashedPassword]);

    // Teachers
    const teacherUser1 = await query.run(`
      INSERT INTO users (school_id, name, email, password, role, phone, address)
      VALUES (?, 'Mr. Chidi Okafor', 'teacher@schoolos.com', ?, 'teacher', '+2348030000004', 'Yaba, Lagos')
    `, [schoolId, hashedPassword]);

    const teacherUser2 = await query.run(`
      INSERT INTO users (school_id, name, email, password, role, phone, address)
      VALUES (?, 'Dr. Sarah Alao', 'sarah.alao@schoolos.com', ?, 'teacher', '+2348030000005', 'Maryland, Lagos')
    `, [schoolId, hashedPassword]);

    // Parents
    const parentUser = await query.run(`
      INSERT INTO users (school_id, name, email, password, role, phone, address)
      VALUES (?, 'Alhaji Ibrahim Musa', 'parent@schoolos.com', ?, 'parent', '+2348030000006', 'Victoria Island, Lagos')
    `, [schoolId, hashedPassword]);

    // Students
    const studentUser1 = await query.run(`
      INSERT INTO users (school_id, name, email, password, role, phone, address)
      VALUES (?, 'Aliyu Musa', 'student@schoolos.com', ?, 'student', '+2348030000007', 'Victoria Island, Lagos')
    `, [schoolId, hashedPassword]);

    const studentUser2 = await query.run(`
      INSERT INTO users (school_id, name, email, password, role, phone, address)
      VALUES (?, 'Aisha Musa', 'aisha.musa@schoolos.com', ?, 'student', '+2348030000008', 'Victoria Island, Lagos')
    `, [schoolId, hashedPassword]);

    // 5. Create Sessions & Terms
    const session = await query.run(`
      INSERT INTO sessions (school_id, name, active)
      VALUES (?, '2025/2026 Academic Session', 1)
    `, [schoolId]);
    const sessionId = session.id;

    const term1 = await query.run(`
      INSERT INTO terms (session_id, name, active)
      VALUES (?, 'First Term', 1)
    `, [sessionId]);
    const termId = term1.id;

    // 6. Create Classes
    const classJss1 = await query.run(`
      INSERT INTO classes (school_id, name, level)
      VALUES (?, 'JSS 1', 'secondary')
    `, [schoolId]);

    const classJss2 = await query.run(`
      INSERT INTO classes (school_id, name, level)
      VALUES (?, 'JSS 2', 'secondary')
    `, [schoolId]);

    const classSss1 = await query.run(`
      INSERT INTO classes (school_id, name, level)
      VALUES (?, 'SSS 1', 'secondary')
    `, [schoolId]);

    // 7. Create Subjects
    const subMath = await query.run(`
      INSERT INTO subjects (school_id, name, code)
      VALUES (?, 'Mathematics', 'MTH101')
    `, [schoolId]);

    const subEng = await query.run(`
      INSERT INTO subjects (school_id, name, code)
      VALUES (?, 'English Language', 'ENG101')
    `, [schoolId]);

    const subSci = await query.run(`
      INSERT INTO subjects (school_id, name, code)
      VALUES (?, 'Basic Science', 'SCI101')
    `, [schoolId]);

    // 8. Map Staff details
    await query.run(`
      INSERT INTO teachers (user_id, employee_no, department, class_id)
      VALUES (?, 'EMP001', 'Science & Mathematics', ?)
    `, [teacherUser1.id, classJss1.id]);

    await query.run(`
      INSERT INTO teachers (user_id, employee_no, department, class_id)
      VALUES (?, 'EMP002', 'Humanities', NULL)
    `, [teacherUser2.id]);

    // 9. Map Student details
    const student1 = await query.run(`
      INSERT INTO students (user_id, class_id, parent_id, admission_no, guardian_name, guardian_phone)
      VALUES (?, ?, ?, 'ADM25001', 'Alhaji Ibrahim Musa', '+2348030000006')
    `, [studentUser1.id, classJss1.id, parentUser.id]);

    const student2 = await query.run(`
      INSERT INTO students (user_id, class_id, parent_id, admission_no, guardian_name, guardian_phone)
      VALUES (?, ?, ?, 'ADM25002', 'Alhaji Ibrahim Musa', '+2348030000006')
    `, [studentUser2.id, classJss2.id, parentUser.id]);

    // 10. Link Teachers to Class Subjects
    await query.run(`
      INSERT INTO class_subjects (class_id, subject_id, teacher_id)
      VALUES (?, ?, ?)
    `, [classJss1.id, subMath.id, teacherUser1.id]);

    await query.run(`
      INSERT INTO class_subjects (class_id, subject_id, teacher_id)
      VALUES (?, ?, ?)
    `, [classJss1.id, subEng.id, teacherUser2.id]);

    await query.run(`
      INSERT INTO class_subjects (class_id, subject_id, teacher_id)
      VALUES (?, ?, ?)
    `, [classJss1.id, subSci.id, teacherUser1.id]);

    await query.run(`
      INSERT INTO class_subjects (class_id, subject_id, teacher_id)
      VALUES (?, ?, ?)
    `, [classJss2.id, subMath.id, teacherUser1.id]);

    // 11. Add Student Attendance
    await query.run(`
      INSERT INTO attendance (student_id, term_id, date, status, remarks)
      VALUES (?, ?, '2026-06-18', 'present', 'On time')
    `, [student1.id, termId]);

    await query.run(`
      INSERT INTO attendance (student_id, term_id, date, status, remarks)
      VALUES (?, ?, '2026-06-19', 'present', 'Participative')
    `, [student1.id, termId]);

    await query.run(`
      INSERT INTO attendance (student_id, term_id, date, status, remarks)
      VALUES (?, ?, '2026-06-20', 'absent', 'Slight fever')
    `, [student1.id, termId]);

    // 12. Add Student Results (CA and Exam)
    // Aliyu Musa results (JSS 1)
    // Math: CA 28, Exam 58 -> Total 86 (A)
    await query.run(`
      INSERT INTO results (student_id, term_id, subject_id, ca_score, exam_score, total_score, grade, comment)
      VALUES (?, ?, ?, 28, 58, 86, 'A', 'Excellent performance, very analytical.')
    `, [student1.id, termId, subMath.id]);

    // Eng: CA 24, Exam 52 -> Total 76 (B)
    await query.run(`
      INSERT INTO results (student_id, term_id, subject_id, ca_score, exam_score, total_score, grade, comment)
      VALUES (?, ?, ?, 24, 52, 76, 'B', 'Shows good understanding of comprehension essays.')
    `, [student1.id, termId, subEng.id]);

    // Sci: CA 20, Exam 45 -> Total 65 (C)
    await query.run(`
      INSERT INTO results (student_id, term_id, subject_id, ca_score, exam_score, total_score, grade, comment)
      VALUES (?, ?, ?, 20, 45, 65, 'C', 'Can perform better with more focus on physics chapters.')
    `, [student1.id, termId, subSci.id]);

    // Aisha Musa results (JSS 2)
    await query.run(`
      INSERT INTO results (student_id, term_id, subject_id, ca_score, exam_score, total_score, grade, comment)
      VALUES (?, ?, ?, 25, 48, 73, 'B', 'Quiet and focused student.')
    `, [student2.id, termId, subMath.id]);

    // 13. Set up Fee Structures (JSS 1 and JSS 2 fees)
    await query.run(`
      INSERT INTO fee_structures (class_id, term_id, fee_name, amount)
      VALUES (?, ?, 'Tuition Fee', 150000)
    `, [classJss1.id, termId]);

    await query.run(`
      INSERT INTO fee_structures (class_id, term_id, fee_name, amount)
      VALUES (?, ?, 'Development Levy', 25000)
    `, [classJss1.id, termId]);

    await query.run(`
      INSERT INTO fee_structures (class_id, term_id, fee_name, amount)
      VALUES (?, ?, 'ICT Laboratory Fee', 15000)
    `, [classJss1.id, termId]);

    await query.run(`
      INSERT INTO fee_structures (class_id, term_id, fee_name, amount)
      VALUES (?, ?, 'Tuition Fee', 160000)
    `, [classJss2.id, termId]);

    // 14. Invoices and Payments
    // Invoice for Student 1 (Aliyu Musa JSS 1) - total 190,000 NGN
    const invoice1 = await query.run(`
      INSERT INTO invoices (student_id, term_id, total_amount, paid_amount, status, due_date)
      VALUES (?, ?, 190000, 150000, 'partial', '2026-07-15')
    `, [student1.id, termId]);

    await query.run(`
      INSERT INTO payments (invoice_id, amount_paid, payment_date, payment_method, receipt_no)
      VALUES (?, 150000, '2026-06-05', 'Bank Transfer', 'REC2026001')
    `, [invoice1.id]);

    // Invoice for Student 2 (Aisha Musa JSS 2) - total 160,000 NGN
    const invoice2 = await query.run(`
      INSERT INTO invoices (student_id, term_id, total_amount, paid_amount, status, due_date)
      VALUES (?, ?, 160000, 160000, 'paid', '2026-07-15')
    `, [student2.id, termId]);

    await query.run(`
      INSERT INTO payments (invoice_id, amount_paid, payment_date, payment_method, receipt_no)
      VALUES (?, 160000, '2026-06-02', 'Card Payment', 'REC2026002')
    `, [invoice2.id]);

    console.log('Database seeded successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Seeding failed with error:', error);
    process.exit(1);
  }
}

seed();
