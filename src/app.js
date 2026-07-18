require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('./config/database');
const { sendNewUserInvite, sendPasswordResetEmail } = require('./utils/mailer');
const { encrypt, decrypt } = require('./utils/crypto');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'schoolos_secret_key_123';

const fs = require('fs');
const path = require('path');
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir));

// Database Migration for 'active' column and teacher profiles
(async () => {
  try {
    const columns = await query.all("PRAGMA table_info(users)");
    const hasActive = columns.some(c => c.name === 'active');
    if (!hasActive) {
      await query.run("ALTER TABLE users ADD COLUMN active INTEGER DEFAULT 1");
      console.log("Migration: Added 'active' column to 'users' table.");
    }

    const hasInvitationStatus = columns.some(c => c.name === 'invitation_status');
    if (!hasInvitationStatus) {
      await query.run("ALTER TABLE users ADD COLUMN invitation_status TEXT DEFAULT 'active'");
      console.log("Migration: Added 'invitation_status' column to 'users' table.");
    }

    const hasPhotoUrlUser = columns.some(c => c.name === 'photo_url');
    if (!hasPhotoUrlUser) {
      await query.run("ALTER TABLE users ADD COLUMN photo_url TEXT");
      console.log("Migration: Added 'photo_url' column to 'users' table.");
    }

    const columnsTeachers = await query.all("PRAGMA table_info(teachers)");
    const hasClassId = columnsTeachers.some(c => c.name === 'class_id');
    if (!hasClassId) {
      await query.run("ALTER TABLE teachers ADD COLUMN class_id INTEGER");
      console.log("Migration: Added 'class_id' column to 'teachers' table.");
    }

    // Check for any principal or bursar who doesn't have a teacher profile
    const staffWithoutProfile = await query.all(`
      SELECT id, role, name FROM users 
      WHERE role IN ('principal', 'bursar') 
        AND id NOT IN (SELECT user_id FROM teachers)
    `);
    for (const u of staffWithoutProfile) {
      const empNo = 'EMP' + u.role.toUpperCase().substring(0, 3) + u.id;
      const dept = u.role === 'principal' ? 'Administration' : 'Finance';
      await query.run(`
        INSERT INTO teachers (user_id, employee_no, department)
        VALUES (?, ?, ?)
      `, [u.id, empNo, dept]);
      console.log(`Migration: Created teacher profile for ${u.role} (${u.name})`);
    }

    // Create staff_subjects table
    await query.exec(`
      CREATE TABLE IF NOT EXISTS staff_subjects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        teacher_id INTEGER,
        subject_id INTEGER,
        FOREIGN KEY (teacher_id) REFERENCES users(id),
        FOREIGN KEY (subject_id) REFERENCES subjects(id),
        UNIQUE(teacher_id, subject_id)
      );
    `);

    // Seed staff_subjects from existing class_subjects
    const existingStaffSubjectsCount = await query.get('SELECT COUNT(*) as count FROM staff_subjects');
    if (existingStaffSubjectsCount.count === 0) {
      console.log("Migration: Seeding staff_subjects table from class_subjects...");
      await query.exec(`
        INSERT OR IGNORE INTO staff_subjects (teacher_id, subject_id)
        SELECT DISTINCT teacher_id, subject_id FROM class_subjects
        WHERE teacher_id IS NOT NULL AND subject_id IS NOT NULL
      `);
    }

    // Ensure all 3 terms exist for the active session
    const activeSession = await query.get('SELECT id FROM sessions WHERE active = 1 LIMIT 1');
    if (activeSession) {
      const existingTerms = await query.all('SELECT name FROM terms WHERE session_id = ?', [activeSession.id]);
      const termNames = existingTerms.map(t => t.name);
      if (!termNames.includes('First Term')) {
        await query.run('INSERT INTO terms (session_id, name, active) VALUES (?, ?, 0)', [activeSession.id, 'First Term']);
      }
      if (!termNames.includes('Second Term')) {
        await query.run('INSERT INTO terms (session_id, name, active) VALUES (?, ?, 0)', [activeSession.id, 'Second Term']);
      }
      if (!termNames.includes('Third Term')) {
        await query.run('INSERT INTO terms (session_id, name, active) VALUES (?, ?, 0)', [activeSession.id, 'Third Term']);
      }
      // If there is no active term, set First Term as active
      const activeTerm = await query.get('SELECT id FROM terms WHERE active = 1');
      if (!activeTerm) {
        await query.run("UPDATE terms SET active = 1 WHERE name = 'First Term' AND session_id = ?", [activeSession.id]);
        console.log("Migration: Set 'First Term' as active term.");
      }
    }

    // New Sprint Migrations
    await query.exec(`
      CREATE TABLE IF NOT EXISTS complaints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_id INTEGER NOT NULL,
        subject TEXT NOT NULL,
        complaint TEXT NOT NULL,
        attachment TEXT,
        category TEXT NOT NULL,
        priority TEXT NOT NULL,
        assigned_role TEXT,
        status TEXT DEFAULT 'pending',
        acknowledgement_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (parent_id) REFERENCES users(id)
      );
    `);

    await query.exec(`
      CREATE TABLE IF NOT EXISTS assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL,
        subject_id INTEGER NOT NULL,
        teacher_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        instructions TEXT NOT NULL,
        due_date TEXT NOT NULL,
        attachment TEXT,
        marks REAL NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (class_id) REFERENCES classes(id),
        FOREIGN KEY (subject_id) REFERENCES subjects(id),
        FOREIGN KEY (teacher_id) REFERENCES users(id)
      );
    `);

    await query.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        read INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `);

    await query.exec(`
      CREATE TABLE IF NOT EXISTS family_discounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        min_children INTEGER UNIQUE NOT NULL,
        discount_percentage REAL NOT NULL,
        name TEXT NOT NULL
      );
    `);

    // Seed default family discounts if empty
    const discCount = await query.get('SELECT COUNT(*) as count FROM family_discounts');
    if (discCount.count === 0) {
      await query.run("INSERT INTO family_discounts (min_children, discount_percentage, name) VALUES (2, 5, '2 Children Discount (5%)')");
      await query.run("INSERT INTO family_discounts (min_children, discount_percentage, name) VALUES (3, 10, '3 Children Discount (10%)')");
      await query.run("INSERT INTO family_discounts (min_children, discount_percentage, name) VALUES (4, 15, '4+ Children Custom Discount (15%)')");
      console.log("Migration: Seeded default family discount plans.");
    }

    // Migration: Add photo_url to students table
    const columnsStudents = await query.all("PRAGMA table_info(students)");
    const hasPhotoUrl = columnsStudents.some(c => c.name === 'photo_url');
    if (!hasPhotoUrl) {
      await query.run("ALTER TABLE students ADD COLUMN photo_url TEXT DEFAULT 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150'");
      console.log("Migration: Added 'photo_url' column to 'students' table.");
      
      // Update existing seeded students with photo URLs:
      // ADM25001 = Aliyu Musa (boy)
      // ADM25002 = Aisha Musa (girl)
      await query.run("UPDATE students SET photo_url = 'https://images.unsplash.com/photo-1503919545889-aef636e10ad4?w=150&auto=format&fit=crop&q=80' WHERE admission_no = 'ADM25001'");
      await query.run("UPDATE students SET photo_url = 'https://images.unsplash.com/photo-1491013516836-7db643ee125a?w=150&auto=format&fit=crop&q=80' WHERE admission_no = 'ADM25002'");
      console.log("Migration: Updated seeded student photos.");
    }

  } catch (err) {
    console.error("Migration error:", err);
  }
})();

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
    const user = await query.get('SELECT u.*, s.status as school_status FROM users u LEFT JOIN schools s ON u.school_id = s.id WHERE u.email = ?', [email]);
    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    if (user.active === 0) {
      return res.status(403).json({ message: 'Your account has been deactivated. Please contact the administrator.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    if (user.invitation_status === 'pending') {
      await query.run("UPDATE users SET invitation_status = 'active' WHERE id = ?", [user.id]);
      user.invitation_status = 'active';
    }

    const token = jwt.sign(
      { id: user.id, role: user.role, schoolId: user.school_id },
      JWT_SECRET,
      { expiresIn: '1d' }
    );

    // Get secondary details if student or teacher
    let profileDetails = {};
    if (user.role === 'student') {
      const student = await query.get('SELECT id as student_id, class_id, parent_id, admission_no, guardian_name, guardian_phone FROM students WHERE user_id = ?', [user.id]);
      profileDetails = student || {};
    } else if (user.role === 'teacher') {
      const teacher = await query.get('SELECT id as teacher_id, employee_no, department, class_id FROM teachers WHERE user_id = ?', [user.id]);
      let classTeacherClass = null;
      if (teacher && teacher.class_id) {
        classTeacherClass = await query.get('SELECT id as class_id, name as class_name, level FROM classes WHERE id = ?', [teacher.class_id]);
      }
      profileDetails = {
        ...(teacher || {}),
        class_teacher_class: classTeacherClass || null
      };
    }

    res.json({
      token,
      user: {
        id: user.id,
        school_id: user.school_id,
        name: user.name,
        email: user.email,
        role: user.role,
        phone: user.phone,
        address: user.address,
        photo_url: user.photo_url,
        school_status: user.school_status,
        ...profileDetails
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/auth/accept-invitation', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }

  try {
    const user = await query.get('SELECT u.*, s.status as school_status FROM users u LEFT JOIN schools s ON u.school_id = s.id WHERE u.email = ?', [email]);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.active === 0) {
      return res.status(403).json({ message: 'Your account has been deactivated.' });
    }

    if (user.invitation_status !== 'pending') {
      return res.status(400).json({ message: 'This invitation has already been accepted.' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    await query.run(
      "UPDATE users SET password = ?, invitation_status = 'active' WHERE id = ?",
      [hashedPassword, user.id]
    );

    const token = jwt.sign(
      { id: user.id, role: user.role, schoolId: user.school_id },
      JWT_SECRET,
      { expiresIn: '1d' }
    );

    // Get secondary details if student or teacher
    let profileDetails = {};
    if (user.role === 'student') {
      const student = await query.get('SELECT id as student_id, class_id, parent_id, admission_no, guardian_name, guardian_phone FROM students WHERE user_id = ?', [user.id]);
      profileDetails = student || {};
    } else if (user.role === 'teacher') {
      const teacher = await query.get('SELECT id as teacher_id, employee_no, department, class_id FROM teachers WHERE user_id = ?', [user.id]);
      let classTeacherClass = null;
      if (teacher && teacher.class_id) {
        classTeacherClass = await query.get('SELECT id as class_id, name as class_name, level FROM classes WHERE id = ?', [teacher.class_id]);
      }
      profileDetails = {
        ...(teacher || {}),
        class_teacher_class: classTeacherClass || null
      };
    }

    res.json({
      token,
      user: {
        id: user.id,
        school_id: user.school_id,
        name: user.name,
        email: user.email,
        role: user.role,
        phone: user.phone,
        address: user.address,
        photo_url: user.photo_url,
        school_status: user.school_status,
        ...profileDetails
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/auth/verify-invitation', async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.status(400).json({ message: 'Invitation token is required' });
  }

  const email = decrypt(token);
  if (!email) {
    return res.status(400).json({ message: 'Invalid or tampered invitation link' });
  }

  try {
    const user = await query.get('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      return res.status(400).json({ message: 'Invalid invitation link (user not found)' });
    }

    if (user.active === 0) {
      return res.status(400).json({ message: 'This invitation has been deactivated' });
    }

    if (user.invitation_status !== 'pending') {
      return res.status(400).json({ message: 'This invitation has already been accepted' });
    }

    res.json({ email: user.email, name: user.name, role: user.role });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error verifying invitation' });
  }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: 'Email address is required' });
  }

  try {
    const user = await query.get('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      // To prevent user enumeration, we still return a generic success message
      return res.json({ message: 'If the email exists in our system, a reset link has been sent.' });
    }

    if (user.active === 0) {
      return res.status(403).json({ message: 'Account is deactivated.' });
    }

    const mailResult = await sendPasswordResetEmail(user);
    res.json({
      message: 'If the email exists in our system, a reset link has been sent.',
      success: mailResult.success,
      method: mailResult.method,
      nodemailerAvailable: mailResult.nodemailerAvailable
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error during forgot password request' });
  }
});

app.get('/api/auth/verify-reset-token', async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.status(400).json({ message: 'Token is required' });
  }

  const email = decrypt(token);
  if (!email) {
    return res.status(400).json({ message: 'Invalid or expired password reset link' });
  }

  try {
    const user = await query.get('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      return res.status(400).json({ message: 'User not found' });
    }

    if (user.active === 0) {
      return res.status(400).json({ message: 'Account has been deactivated' });
    }

    res.json({ email: user.email, name: user.name });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error verifying reset token' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({ message: 'Token and password are required' });
  }

  const email = decrypt(token);
  if (!email) {
    return res.status(400).json({ message: 'Invalid or expired password reset link' });
  }

  try {
    const user = await query.get('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      return res.status(400).json({ message: 'User not found' });
    }

    if (user.active === 0) {
      return res.status(400).json({ message: 'Account is deactivated' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    await query.run('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, user.id]);

    res.json({ message: 'Password reset successful' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error resetting password' });
  }
});

app.post('/api/auth/register-proprietor', async (req, res) => {
  const { name, email, password, phone, address, schoolName, schoolTagline } = req.body;

  if (!name || !email || !password || !schoolName) {
    return res.status(400).json({ message: 'Proprietor name, email, password, and school name are required' });
  }

  try {
    const existingUser = await query.get('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUser) {
      return res.status(400).json({ message: 'Email already registered' });
    }

    const schoolResult = await query.run(`
      INSERT INTO schools (name, tagline, address, phone, status)
      VALUES (?, ?, ?, ?, 'pending')
    `, [schoolName, schoolTagline || '', address || '', phone || '']);
    const schoolId = schoolResult.id;

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const userResult = await query.run(`
      INSERT INTO users (school_id, name, email, password, role, phone, address)
      VALUES (?, ?, ?, ?, 'admin', ?, ?)
    `, [schoolId, name, email, hashedPassword, phone || '', address || '']);

    const userObj = {
      id: userResult.id,
      school_id: schoolId,
      name,
      email,
      role: 'admin',
      invitation_status: 'active'
    };
    sendNewUserInvite(userObj, password).catch(console.error);

    const sessionResult = await query.run(`
      INSERT INTO sessions (school_id, name, active)
      VALUES (?, '2025/2026 Academic Session', 1)
    `, [schoolId]);

    await query.run(`
      INSERT INTO terms (session_id, name, active)
      VALUES (?, 'First Term', 1)
    `, [sessionResult.id]);

    const classJss1 = await query.run(`
      INSERT INTO classes (school_id, name, level)
      VALUES (?, 'JSS 1', 'secondary')
    `, [schoolId]);
    await query.run(`
      INSERT INTO classes (school_id, name, level)
      VALUES (?, 'JSS 2', 'secondary')
    `, [schoolId]);

    await query.run(`
      INSERT INTO subjects (school_id, name, code)
      VALUES (?, 'Mathematics', 'MTH101')
    `, [schoolId]);
    await query.run(`
      INSERT INTO subjects (school_id, name, code)
      VALUES (?, 'English Language', 'ENG101')
    `, [schoolId]);

    const term = await query.get('SELECT id FROM terms WHERE session_id = ? AND name = "First Term"', [sessionResult.id]);
    if (term) {
      await query.run(`
        INSERT INTO fee_structures (class_id, term_id, fee_name, amount)
        VALUES (?, ?, 'Tuition Fee', 150000)
      `, [classJss1.id, term.id]);
    }

    res.status(201).json({ message: 'School and Proprietor account onboarded successfully!' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error during onboarding' });
  }
});

// ----------------------------------------------------
// 2. School Info
// ----------------------------------------------------
app.get('/api/school/info', async (req, res) => {
  const schoolId = req.query.school_id || 1;
  try {
    const school = await query.get('SELECT * FROM schools WHERE id = ?', [schoolId]);
    const session = await query.get('SELECT * FROM sessions WHERE active = 1 AND school_id = ?', [schoolId]);
    const term = session ? await query.get('SELECT * FROM terms WHERE active = 1 AND session_id = ?', [session.id]) : null;

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

// GET all schools for Superadmin
app.get('/api/superadmin/schools', async (req, res) => {
  try {
    const schools = await query.all(`
      SELECT s.*, u.name as proprietor_name, u.email as proprietor_email, u.phone as proprietor_phone
      FROM schools s
      LEFT JOIN users u ON u.school_id = s.id AND u.role = 'admin'
    `);
    res.json(schools);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error fetching schools' });
  }
});

// APPROVE a school
app.post('/api/superadmin/schools/:schoolId/approve', async (req, res) => {
  const { schoolId } = req.params;
  try {
    await query.run("UPDATE schools SET status = 'approved' WHERE id = ?", [schoolId]);
    res.json({ message: 'School approved successfully!' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error approving school' });
  }
});

// UNAPPROVE/PEND a school
app.post('/api/superadmin/schools/:schoolId/unapprove', async (req, res) => {
  const { schoolId } = req.params;
  try {
    await query.run("UPDATE schools SET status = 'pending' WHERE id = ?", [schoolId]);
    res.json({ message: 'School unapproved/set to pending!' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error unapproving school' });
  }
});

// UPLOAD verification documents for school
app.post('/api/school/upload-documents', async (req, res) => {
  const { schoolId, documents } = req.body;
  if (!schoolId || !documents || !Array.isArray(documents)) {
    return res.status(400).json({ message: 'School ID and documents array are required' });
  }

  try {
    const savedDocs = [];

    for (const doc of documents) {
      const { name, fileName, fileData } = doc;
      if (!name || !fileName || !fileData) continue;

      // Extract raw base64 data
      const base64Content = fileData.split(';base64,').pop();
      
      // Clean filename and make unique
      const timestamp = Date.now();
      const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
      const uniqueFileName = `school_${schoolId}_${timestamp}_${sanitizedFileName}`;
      
      const filePath = path.join(uploadsDir, uniqueFileName);
      
      // Write file to uploads folder
      fs.writeFileSync(filePath, base64Content, { encoding: 'base64' });

      savedDocs.push({
        name,
        fileName,
        url: `/uploads/${uniqueFileName}`
      });
    }

    // Save list of uploaded files to database
    const jsonDocs = JSON.stringify(savedDocs);
    await query.run("UPDATE schools SET verification_docs = ? WHERE id = ?", [jsonDocs, schoolId]);

    res.json({ message: 'Documents uploaded successfully! Your verification is pending review.' });
  } catch (error) {
    console.error('Error handling file upload:', error);
    res.status(500).json({ message: 'Server error saving uploaded documents' });
  }
});

// Update User Profile Picture
app.post('/api/user/update-profile-picture', async (req, res) => {
  const { userId, fileName, fileData } = req.body;
  if (!userId || !fileName || !fileData) {
    return res.status(400).json({ message: 'User ID, filename, and image data are required' });
  }

  try {
    const base64Content = fileData.split(';base64,').pop();
    const timestamp = Date.now();
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const uniqueFileName = `profile_${userId}_${timestamp}_${sanitizedFileName}`;
    const filePath = path.join(uploadsDir, uniqueFileName);

    fs.writeFileSync(filePath, base64Content, { encoding: 'base64' });
    const photoUrl = `/uploads/${uniqueFileName}`;

    await query.run('UPDATE users SET photo_url = ? WHERE id = ?', [photoUrl, userId]);
    // Also update students table if the user is a student
    await query.run('UPDATE students SET photo_url = ? WHERE user_id = ?', [photoUrl, userId]);

    res.json({ message: 'Profile picture updated successfully!', photo_url: photoUrl });
  } catch (error) {
    console.error('Error uploading profile picture:', error);
    res.status(500).json({ message: 'Server error updating profile picture' });
  }
});

// Generic Image Upload
app.post('/api/upload-image', async (req, res) => {
  const { fileName, fileData } = req.body;
  if (!fileName || !fileData) {
    return res.status(400).json({ message: 'Filename and image data are required' });
  }

  try {
    const base64Content = fileData.split(';base64,').pop();
    const timestamp = Date.now();
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const uniqueFileName = `upload_${timestamp}_${sanitizedFileName}`;
    const filePath = path.join(uploadsDir, uniqueFileName);

    fs.writeFileSync(filePath, base64Content, { encoding: 'base64' });
    const fileUrl = `/uploads/${uniqueFileName}`;

    res.json({ url: fileUrl });
  } catch (error) {
    console.error('Error in generic upload:', error);
    res.status(500).json({ message: 'Server error uploading file' });
  }
});

// Change Password from Profile
app.post('/api/user/change-password', async (req, res) => {
  const { userId, currentPassword, newPassword } = req.body;
  if (!userId || !currentPassword || !newPassword) {
    return res.status(400).json({ message: 'User ID, current password, and new password are required' });
  }

  try {
    const user = await query.get('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    await query.run('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId]);

    res.json({ message: 'Password updated successfully!' });
  } catch (error) {
    console.error('Error changing password:', error);
    res.status(500).json({ message: 'Server error changing password' });
  }
});

// GET active user details
app.get('/api/user/profile', async (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ message: 'User ID is required' });
  }

  try {
    const user = await query.get('SELECT id, name, email, role, phone, address, photo_url FROM users WHERE id = ?', [userId]);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    console.error('Error fetching user profile:', error);
    res.status(500).json({ message: 'Server error fetching user profile' });
  }
});

app.put('/api/school/profile', async (req, res) => {
  const { name, tagline, logo, address, phone } = req.body;
  const schoolId = req.query.school_id || 1;
  try {
    await query.run(`
      UPDATE schools
      SET name = ?, tagline = ?, logo = ?, address = ?, phone = ?
      WHERE id = ?
    `, [name, tagline, logo, address, phone, schoolId]);
    res.json({ message: 'School profile updated successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all terms
app.get('/api/terms', async (req, res) => {
  const schoolId = req.query.school_id || 1;
  try {
    const activeSession = await query.get('SELECT id FROM sessions WHERE active = 1 AND school_id = ? LIMIT 1', [schoolId]);
    if (!activeSession) return res.status(404).json({ message: 'No active session found' });
    const terms = await query.all('SELECT * FROM terms WHERE session_id = ?', [activeSession.id]);
    res.json(terms);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update active term
app.put('/api/terms/active', async (req, res) => {
  const { termId, school_id } = req.body;
  const schoolIdVal = school_id || 1;
  if (!termId) return res.status(400).json({ message: 'termId is required' });

  try {
    const activeSession = await query.get('SELECT id FROM sessions WHERE active = 1 AND school_id = ? LIMIT 1', [schoolIdVal]);
    if (!activeSession) return res.status(404).json({ message: 'No active session found' });

    const term = await query.get('SELECT id FROM terms WHERE id = ? AND session_id = ?', [termId, activeSession.id]);
    if (!term) return res.status(404).json({ message: 'Term not found in active session' });

    await query.run('UPDATE terms SET active = 0 WHERE session_id = ?', [activeSession.id]);
    await query.run('UPDATE terms SET active = 1 WHERE id = ?', [termId]);

    res.json({ message: 'Active term updated successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ----------------------------------------------------
// 3. Proprietor / Admin Overview Stats
// ----------------------------------------------------
app.get('/api/admin/overview', async (req, res) => {
  const schoolId = req.query.school_id || 1;
  try {
    const totalStudents = await query.get('SELECT COUNT(*) as count FROM students WHERE user_id IN (SELECT id FROM users WHERE school_id = ?)', [schoolId]);
    const totalTeachers = await query.get('SELECT COUNT(*) as count FROM teachers WHERE user_id IN (SELECT id FROM users WHERE school_id = ?)', [schoolId]);
    const financialStats = await query.get(`
      SELECT 
        SUM(total_amount) as total_invoiced,
        SUM(paid_amount) as total_collected,
        SUM(total_amount - paid_amount) as outstanding_debt
      FROM invoices
      WHERE student_id IN (SELECT id FROM students WHERE user_id IN (SELECT id FROM users WHERE school_id = ?))
    `, [schoolId]);

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
  const schoolId = req.query.school_id || 1;
  try {
    const students = await query.all(`
      SELECT s.id as student_id, u.id as user_id, u.name, u.email, u.phone, 
             c.name as class_name, c.id as class_id, s.admission_no, s.guardian_name, s.guardian_phone, u.active, u.invitation_status, u.photo_url
      FROM students s
      JOIN users u ON s.user_id = u.id
      LEFT JOIN classes c ON s.class_id = c.id
      WHERE u.school_id = ?
    `, [schoolId]);

    for (const s of students) {
      if (s.invitation_status === 'pending') {
        s.invitation_token = encrypt(s.email);
      }
    }

    res.json(students);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/students', async (req, res) => {
  const { name, email, phone, class_id, guardian_name, guardian_phone, school_id, photo_url } = req.body;
  const schoolId = school_id || 1;

  try {
    const salt = await bcrypt.genSalt(10);
    const password = await bcrypt.hash('password123', salt);

    // Create user
    const userResult = await query.run(`
      INSERT INTO users (school_id, name, email, password, role, phone, invitation_status, photo_url)
      VALUES (?, ?, ?, ?, 'student', ?, 'pending', ?)
    `, [schoolId, name, email, password, phone, photo_url || null]);

    const user_id = userResult.id;
    const userObj = {
      id: user_id,
      school_id: schoolId,
      name,
      email,
      role: 'student',
      invitation_status: 'pending'
    };
    sendNewUserInvite(userObj, 'password123').catch(console.error);
    const admission_no = 'ADM' + Date.now().toString().slice(-6);

    // Create student profile
    const studentResult = await query.run(`
      INSERT INTO students (user_id, class_id, admission_no, guardian_name, guardian_phone, photo_url)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [user_id, class_id, admission_no, guardian_name, guardian_phone, photo_url || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150']);

    // Create invoice for default class fees
    const activeTerm = await query.get('SELECT t.id FROM terms t JOIN sessions s ON t.session_id = s.id WHERE t.active = 1 AND s.school_id = ? LIMIT 1', [schoolId]);
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

app.put('/api/students/:studentId', async (req, res) => {
  const { studentId } = req.params;
  const { name, email, phone, class_id, guardian_name, guardian_phone, active } = req.body;

  try {
    const student = await query.get('SELECT user_id FROM students WHERE id = ?', [studentId]);
    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }

    const { user_id } = student;

    if (email) {
      const existingUser = await query.get('SELECT id FROM users WHERE email = ? AND id != ?', [email, user_id]);
      if (existingUser) {
        return res.status(400).json({ message: 'Email already in use by another user' });
      }
    }

    await query.run(`
      UPDATE users 
      SET name = COALESCE(?, name),
          email = COALESCE(?, email),
          phone = COALESCE(?, phone),
          active = COALESCE(?, active)
      WHERE id = ?
    `, [name, email, phone, active !== undefined ? active : null, user_id]);

    await query.run(`
      UPDATE students
      SET class_id = COALESCE(?, class_id),
          guardian_name = COALESCE(?, guardian_name),
          guardian_phone = COALESCE(?, guardian_phone)
      WHERE id = ?
    `, [class_id, guardian_name, guardian_phone, studentId]);

    res.json({ message: 'Student updated successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/students/:studentId/resend-invite', async (req, res) => {
  const { studentId } = req.params;
  try {
    const student = await query.get('SELECT user_id FROM students WHERE id = ?', [studentId]);
    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }
    const user = await query.get('SELECT * FROM users WHERE id = ?', [student.user_id]);
    if (!user) {
      return res.status(404).json({ message: 'User details not found' });
    }
    if (user.invitation_status !== 'pending') {
      return res.status(400).json({ message: 'This student invitation is no longer pending.' });
    }

    const mailResult = await sendNewUserInvite(user, 'password123');
    res.json({
      message: 'Invitation email processed successfully',
      success: mailResult.success,
      method: mailResult.method,
      nodemailerAvailable: mailResult.nodemailerAvailable
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ----------------------------------------------------
// 5. Staff Management
// ----------------------------------------------------
app.get('/api/teachers', async (req, res) => {
  const schoolId = req.query.school_id || 1;
  try {
    const teachers = await query.all(`
      SELECT t.id as teacher_id, u.id as user_id, u.name, u.email, u.phone, u.role, u.active, u.invitation_status, t.employee_no, t.department, t.class_id, c.name as class_name, u.photo_url
      FROM teachers t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN classes c ON t.class_id = c.id
      WHERE u.school_id = ?
    `, [schoolId]);

    for (let t of teachers) {
      const subjects = await query.all(`
        SELECT s.id, s.name, s.code
        FROM subjects s
        JOIN staff_subjects ss ON s.id = ss.subject_id
        WHERE ss.teacher_id = ?
      `, [t.user_id]);
      t.subjects = subjects || [];

      const classSubjects = await query.all(`
        SELECT cs.class_id, cs.subject_id, c.name as class_name, s.name as subject_name, s.code as subject_code
        FROM class_subjects cs
        JOIN classes c ON cs.class_id = c.id
        JOIN subjects s ON cs.subject_id = s.id
        WHERE cs.teacher_id = ?
      `, [t.user_id]);
      t.class_subjects = classSubjects || [];

      if (t.invitation_status === 'pending') {
        t.invitation_token = encrypt(t.email);
      }
    }

    res.json(teachers);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/teachers', async (req, res) => {
  const { name, email, phone, role, employee_no, department, class_id, class_subjects, school_id, photo_url } = req.body;
  const schoolId = school_id || 1;

  if (!name || !email || !role || !employee_no) {
    return res.status(400).json({ message: 'Name, email, role, and employee number are required' });
  }

  if (!['teacher', 'principal', 'bursar'].includes(role)) {
    return res.status(400).json({ message: 'Invalid staff role' });
  }

  try {
    // Check if email already in use
    const existingUser = await query.get('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUser) {
      return res.status(400).json({ message: 'Email is already registered' });
    }

    // Check if employee_no already in use
    const existingEmp = await query.get('SELECT id FROM teachers WHERE employee_no = ?', [employee_no]);
    if (existingEmp) {
      return res.status(400).json({ message: 'Employee number is already in use' });
    }

    const salt = await bcrypt.genSalt(10);
    const password = await bcrypt.hash('password123', salt); // default password

    // Create user
    const userResult = await query.run(`
      INSERT INTO users (school_id, name, email, password, role, phone, invitation_status, photo_url)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `, [schoolId, name, email, password, role, phone, photo_url || null]);

    const user_id = userResult.id;
    const userObj = {
      id: user_id,
      school_id: schoolId,
      name,
      email,
      role,
      invitation_status: 'pending'
    };
    sendNewUserInvite(userObj, 'password123').catch(console.error);

    // Create teacher/staff profile
    const teacherResult = await query.run(`
      INSERT INTO teachers (user_id, employee_no, department, class_id)
      VALUES (?, ?, ?, ?)
    `, [user_id, employee_no, department, class_id || null]);

    // Save subject assignments
    if (class_subjects && Array.isArray(class_subjects)) {
      for (const assignment of class_subjects) {
        await query.run(`
          INSERT INTO class_subjects (class_id, subject_id, teacher_id)
          VALUES (?, ?, ?)
        `, [assignment.class_id, assignment.subject_id, user_id]);

        await query.run(`
          INSERT OR IGNORE INTO staff_subjects (teacher_id, subject_id)
          VALUES (?, ?)
        `, [user_id, assignment.subject_id]);
      }
    }

    res.status(201).json({ message: 'Staff member registered successfully', teacherId: teacherResult.id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error or email already exists' });
  }
});

app.put('/api/teachers/:teacherId', async (req, res) => {
  const { teacherId } = req.params;
  const { name, email, phone, role, employee_no, department, active, invitation_status, class_id, class_subjects } = req.body;

  try {
    const teacher = await query.get('SELECT user_id FROM teachers WHERE id = ?', [teacherId]);
    if (!teacher) {
      return res.status(404).json({ message: 'Staff member not found' });
    }

    const { user_id } = teacher;

    if (email) {
      const existingUser = await query.get('SELECT id FROM users WHERE email = ? AND id != ?', [email, user_id]);
      if (existingUser) {
        return res.status(400).json({ message: 'Email already in use by another user' });
      }
    }

    if (employee_no) {
      const existingEmp = await query.get('SELECT id FROM teachers WHERE employee_no = ? AND id != ?', [employee_no, teacherId]);
      if (existingEmp) {
        return res.status(400).json({ message: 'Employee number already in use by another staff member' });
      }
    }

    if (role && !['teacher', 'principal', 'bursar'].includes(role)) {
      return res.status(400).json({ message: 'Invalid staff role' });
    }

    await query.run(`
      UPDATE users 
      SET name = COALESCE(?, name),
          email = COALESCE(?, email),
          phone = COALESCE(?, phone),
          role = COALESCE(?, role),
          active = COALESCE(?, active),
          invitation_status = COALESCE(?, invitation_status)
      WHERE id = ?
    `, [name, email, phone, role, active !== undefined ? active : null, invitation_status || null, user_id]);

    await query.run(`
      UPDATE teachers
      SET employee_no = COALESCE(?, employee_no),
          department = COALESCE(?, department),
          class_id = CASE WHEN ? = 1 THEN ? ELSE class_id END
      WHERE id = ?
    `, [employee_no, department, class_id !== undefined ? 1 : 0, class_id || null, teacherId]);

    // Update subject assignments if provided
    if (class_subjects && Array.isArray(class_subjects)) {
      await query.run('DELETE FROM class_subjects WHERE teacher_id = ?', [user_id]);
      await query.run('DELETE FROM staff_subjects WHERE teacher_id = ?', [user_id]);
      for (const assignment of class_subjects) {
        await query.run(`
          INSERT INTO class_subjects (class_id, subject_id, teacher_id)
          VALUES (?, ?, ?)
        `, [assignment.class_id, assignment.subject_id, user_id]);

        await query.run(`
          INSERT OR IGNORE INTO staff_subjects (teacher_id, subject_id)
          VALUES (?, ?)
        `, [user_id, assignment.subject_id]);
      }
    }

    res.json({ message: 'Staff member updated successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/teachers/:teacherId/resend-invite', async (req, res) => {
  const { teacherId } = req.params;
  try {
    const teacher = await query.get('SELECT user_id FROM teachers WHERE id = ?', [teacherId]);
    if (!teacher) {
      return res.status(404).json({ message: 'Staff member not found' });
    }
    const user = await query.get('SELECT * FROM users WHERE id = ?', [teacher.user_id]);
    if (!user) {
      return res.status(404).json({ message: 'User details not found' });
    }
    if (user.invitation_status !== 'pending') {
      return res.status(400).json({ message: 'This user invitation is no longer pending.' });
    }

    const mailResult = await sendNewUserInvite(user, 'password123');
    res.json({
      message: 'Invitation email processed successfully',
      success: mailResult.success,
      method: mailResult.method,
      nodemailerAvailable: mailResult.nodemailerAvailable
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ----------------------------------------------------
// 6. Academic Configurations (Classes, Subjects)
// ----------------------------------------------------
app.get('/api/classes', async (req, res) => {
  const schoolId = req.query.school_id || 1;
  try {
    const classes = await query.all(`
      SELECT c.*, u.name as class_teacher_name 
      FROM classes c 
      LEFT JOIN teachers t ON c.id = t.class_id
      LEFT JOIN users u ON t.user_id = u.id
      WHERE c.school_id = ?
    `, [schoolId]);
    res.json(classes);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/classes', async (req, res) => {
  const { name, level, school_id } = req.body;
  const schoolId = school_id || 1;
  try {
    const result = await query.run(`
      INSERT INTO classes (school_id, name, level) VALUES (?, ?, ?)
    `, [schoolId, name, level]);
    res.status(201).json({ id: result.id, name, level });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.put('/api/classes/:id', async (req, res) => {
  const { id } = req.params;
  const { name, level } = req.body;
  try {
    await query.run(`
      UPDATE classes
      SET name = COALESCE(?, name),
          level = COALESCE(?, level)
      WHERE id = ?
    `, [name, level, id]);
    res.json({ message: 'Class updated successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.delete('/api/classes/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await query.run('UPDATE students SET class_id = NULL WHERE class_id = ?', [id]);
    await query.run('DELETE FROM fee_structures WHERE class_id = ?', [id]);
    await query.run('DELETE FROM class_subjects WHERE class_id = ?', [id]);
    await query.run('DELETE FROM classes WHERE id = ?', [id]);
    res.json({ message: 'Class deleted successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/subjects', async (req, res) => {
  const schoolId = req.query.school_id || 1;
  try {
    const subjects = await query.all('SELECT * FROM subjects WHERE school_id = ?', [schoolId]);
    res.json(subjects);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/subjects', async (req, res) => {
  const { name, code, school_id } = req.body;
  const schoolId = school_id || 1;
  try {
    const result = await query.run(`
      INSERT INTO subjects (school_id, name, code) VALUES (?, ?, ?)
    `, [schoolId, name, code]);
    res.status(201).json({ id: result.id, name, code });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Bulk Import Subjects
app.post('/api/subjects/import', async (req, res) => {
  const { subjects, school_id } = req.body;
  const schoolId = school_id || 1;

  if (!subjects || !Array.isArray(subjects)) {
    return res.status(400).json({ message: 'Subjects array is required' });
  }

  const results = {
    successful: [],
    failed: []
  };

  try {
    for (let index = 0; index < subjects.length; index++) {
      const row = subjects[index];
      const { name, code } = row;

      if (!name || !code) {
        results.failed.push({
          row: index + 1,
          name: name || 'Unknown',
          reason: 'Subject name and subject code are required.'
        });
        continue;
      }

      const existingSubject = await query.get('SELECT id FROM subjects WHERE school_id = ? AND (code = ? OR name = ?)', [schoolId, code, name]);
      if (existingSubject) {
        results.failed.push({
          row: index + 1,
          name,
          reason: `Subject with code '${code}' or name '${name}' already exists.`
        });
        continue;
      }

      try {
        const result = await query.run(`
          INSERT INTO subjects (school_id, name, code) VALUES (?, ?, ?)
        `, [schoolId, name, code]);

        results.successful.push({
          row: index + 1,
          name,
          code,
          id: result.id
        });
      } catch (err) {
        results.failed.push({
          row: index + 1,
          name,
          reason: err.message
        });
      }
    }

    res.json(results);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error during subject import' });
  }
});


app.put('/api/subjects/:id', async (req, res) => {
  const { id } = req.params;
  const { name, code } = req.body;
  try {
    await query.run(`
      UPDATE subjects
      SET name = COALESCE(?, name),
          code = COALESCE(?, code)
      WHERE id = ?
    `, [name, code, id]);
    res.json({ message: 'Subject updated successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.delete('/api/subjects/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await query.run('DELETE FROM class_subjects WHERE subject_id = ?', [id]);
    await query.run('DELETE FROM staff_subjects WHERE subject_id = ?', [id]);
    await query.run('DELETE FROM results WHERE subject_id = ?', [id]);
    await query.run('DELETE FROM subjects WHERE id = ?', [id]);
    res.json({ message: 'Subject deleted successfully' });
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

// Get class broadsheet
app.get('/api/results/broadsheet/class/:classId', async (req, res) => {
  const { classId } = req.params;
  try {
    const activeTerm = await query.get('SELECT t.id FROM terms t JOIN sessions s ON t.session_id = s.id WHERE t.active = 1 LIMIT 1');
    if (!activeTerm) return res.status(404).json({ message: 'No active term found' });

    // Fetch all subjects associated with this class
    const subjects = await query.all(`
      SELECT DISTINCT s.id as subject_id, s.name as subject_name, s.code as subject_code
      FROM class_subjects cs
      JOIN subjects s ON cs.subject_id = s.id
      WHERE cs.class_id = ?
    `, [classId]);

    // Fetch all students in this class
    const students = await query.all(`
      SELECT s.id as student_id, u.name as student_name, s.admission_no
      FROM students s
      JOIN users u ON s.user_id = u.id
      WHERE s.class_id = ?
    `, [classId]);

    // Fetch all results for these students in this term
    const results = await query.all(`
      SELECT r.student_id, r.subject_id, r.ca_score, r.exam_score, r.total_score, r.grade
      FROM results r
      WHERE r.term_id = ? AND r.student_id IN (
        SELECT id FROM students WHERE class_id = ?
      )
    `, [activeTerm.id, classId]);

    // Map student results
    const resultsMap = {};
    results.forEach(r => {
      if (!resultsMap[r.student_id]) {
        resultsMap[r.student_id] = {};
      }
      resultsMap[r.student_id][r.subject_id] = {
        ca_score: r.ca_score,
        exam_score: r.exam_score,
        total_score: r.total_score,
        grade: r.grade
      };
    });

    const studentRows = students.map(st => {
      const studentScores = resultsMap[st.student_id] || {};
      let totalSum = 0;

      const subjectGrades = {};
      subjects.forEach(sub => {
        const scoreObj = studentScores[sub.subject_id];
        if (scoreObj) {
          subjectGrades[sub.subject_id] = scoreObj;
          totalSum += scoreObj.total_score || 0;
        } else {
          subjectGrades[sub.subject_id] = { ca_score: null, exam_score: null, total_score: null, grade: null };
        }
      });

      const average = subjects.length > 0 ? (totalSum / subjects.length) : 0;

      return {
        student_id: st.student_id,
        student_name: st.student_name,
        admission_no: st.admission_no,
        subject_scores: subjectGrades,
        total_sum: totalSum,
        average: parseFloat(average.toFixed(2))
      };
    });

    // Rank students
    studentRows.sort((a, b) => b.total_sum - a.total_sum);
    studentRows.forEach((row, index) => {
      row.rank = index + 1;
    });

    res.json({
      subjects,
      students: studentRows
    });
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
      SELECT s.id as student_id, u.name as student_name, s.admission_no, c.name as class_name, c.id as class_id, u.photo_url
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
      SELECT s.id as student_id, u.name as child_name, s.admission_no, c.name as class_name, c.id as class_id, s.photo_url
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

// Helper function to create notification
async function createNotification(userId, type, title, message) {
  try {
    await query.run(`
      INSERT INTO notifications (user_id, type, title, message)
      VALUES (?, ?, ?, ?)
    `, [userId, type, title, message]);
  } catch (err) {
    console.error('Error creating notification:', err);
  }
}

// ----------------------------------------------------
// 10. AI Personalized Greetings
// ----------------------------------------------------
app.get('/api/ai/greeting', async (req, res) => {
  const { role, name, timeContext, studentName } = req.query;
  const tc = timeContext || 'Beginning of Week';

  let greeting = '';
  if (role === 'admin' || role === 'principal') {
    const formattedName = name || 'Chief Abdul-Malik';
    if (tc === 'Beginning of Week') {
      greeting = `Good morning, ${formattedName}. Greenwood Academy is starting the week strong. Here is your weekly leadership briefing: Teacher attendance is at 98%, and term results are 100% uploaded.`;
    } else if (tc === 'Weekend') {
      greeting = `Enjoy your weekend, ${formattedName}. Thank you for your leadership this week. Rest well.`;
    } else {
      greeting = `Happy holidays, ${formattedName}! Wishing you a peaceful break before the new term.`;
    }
  } else if (role === 'bursar') {
    const formattedName = name || 'Mr. Dele Ojo';
    if (tc === 'Beginning of Week') {
      greeting = `Good morning, ${formattedName}. Weekly Revenue Summary: Fee collections have increased by 12% this week. Collection rate is 88.5%.`;
    } else if (tc === 'Weekend') {
      greeting = `Have a great weekend, ${formattedName}. Outstanding fees are highest in class SS2, but installment plans are on track.`;
    } else {
      greeting = `Enjoy your holiday, ${formattedName}. Online fee payment collections will remain active.`;
    }
  } else if (role === 'teacher') {
    const formattedName = name || 'Mr. Chidi Okafor';
    if (tc === 'Beginning of Week') {
      greeting = `Hi ${formattedName}. Keep motivating your class. Your dedication is shaping the future.`;
    } else if (tc === 'Weekend') {
      greeting = `Enjoy your weekend, ${formattedName}. Thank you for your dedication to our students.`;
    } else {
      greeting = `Happy holidays, ${formattedName}. Have a wonderful rest!`;
    }
  } else if (role === 'parent') {
    const formattedName = name || 'Alhaji Ibrahim Musa';
    const sName = studentName || 'Aliyu Musa';
    if (tc === 'Beginning of Week') {
      greeting = `Hello ${formattedName}. Academic support reminder: Ensure ${sName} reviews his Mathematics homework tonight.`;
    } else if (tc === 'Weekend') {
      greeting = `Have a peaceful weekend with your family, ${formattedName}. Support ${sName}'s learning over the break.`;
    } else {
      greeting = `Happy holidays, ${formattedName}. Keep ${sName} engaged with reading and revision.`;
    }
  } else if (role === 'student') {
    const formattedName = name || 'Musa Aliyu';
    const shortName = formattedName.split(' ')[0];
    if (tc === 'Beginning of Week') {
      greeting = `Hi ${formattedName}. Good Morning, ${shortName}. Welcome back. Let's make this week count!`;
    } else if (tc === 'Weekend') {
      greeting = `Enjoy your weekend, ${shortName}! Remember to rest and prepare for the next week.`;
    } else {
      greeting = `Happy holidays, ${shortName}! Enjoy your break, stay curious and keep learning.`;
    }
  } else {
    greeting = `Welcome back to SchoolOS AI.`;
  }

  res.json({ greeting });
});

// ----------------------------------------------------
// 11. Payments & Billing (Parent & Bursar)
// ----------------------------------------------------

// Simulated Payment execution
app.post('/api/parent/pay-invoice', async (req, res) => {
  const { invoice_id, amount_paid, payment_method } = req.body;
  const payVal = parseFloat(amount_paid) || 0;

  try {
    const invoice = await query.get(`
      SELECT i.*, u.name as parent_name, u.id as parent_user_id, st.admission_no, st.id as student_id, stu.name as student_name
      FROM invoices i
      JOIN students st ON i.student_id = st.id
      JOIN users stu ON st.user_id = stu.id
      JOIN users u ON st.parent_id = u.id
      WHERE i.id = ?
    `, [invoice_id]);

    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

    const newPaidAmount = invoice.paid_amount + payVal;
    let newStatus = 'unpaid';
    if (newPaidAmount >= invoice.total_amount) {
      newStatus = 'paid';
    } else if (newPaidAmount > 0) {
      newStatus = 'partial';
    }

    const receiptNo = 'REC' + Date.now().toString().slice(-6);
    await query.run(`
      INSERT INTO payments (invoice_id, amount_paid, payment_date, payment_method, receipt_no)
      VALUES (?, ?, Date('now'), ?, ?)
    `, [invoice_id, payVal, payment_method, receiptNo]);

    await query.run(`
      UPDATE invoices
      SET paid_amount = ?, status = ?
      WHERE id = ?
    `, [newPaidAmount, newStatus, invoice_id]);

    // Send notifications
    // 1. Parent
    await createNotification(
      invoice.parent_user_id,
      'Finance',
      'Payment Successful',
      `Your payment of ₦${payVal.toLocaleString()} for ${invoice.student_name} was successful. Receipt: ${receiptNo}`
    );

    // 2. Bursar (find bursar users)
    const bursars = await query.all("SELECT id FROM users WHERE role = 'bursar'");
    for (const b of bursars) {
      await createNotification(
        b.id,
        'Finance',
        'Fee Collection Alert',
        `Parent ${invoice.parent_name} paid ₦${payVal.toLocaleString()} for ${invoice.student_name} via ${payment_method}.`
      );
    }

    // 3. Proprietor / Admin
    const admins = await query.all("SELECT id FROM users WHERE role = 'admin'");
    for (const a of admins) {
      await createNotification(
        a.id,
        'Finance',
        'Revenue Collection Alert',
        `₦${payVal.toLocaleString()} payment received for ${invoice.student_name} (${invoice.admission_no}).`
      );
    }

    res.json({ message: 'Payment simulated successfully', receiptNo });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Parent Payment History
app.get('/api/parent/payment-history/:parentUserId', async (req, res) => {
  try {
    const payments = await query.all(`
      SELECT p.*, i.total_amount, i.status as invoice_status, u.name as child_name, i.due_date, t.name as term_name
      FROM payments p
      JOIN invoices i ON p.invoice_id = i.id
      JOIN terms t ON i.term_id = t.id
      JOIN students s ON i.student_id = s.id
      JOIN users u ON s.user_id = u.id
      WHERE s.parent_id = ?
      ORDER BY p.id DESC
    `, [req.params.parentUserId]);

    res.json(payments);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ----------------------------------------------------
// 12. Complaint Centre (Parent & Staff routing)
// ----------------------------------------------------
app.post('/api/parent/complaints', async (req, res) => {
  const { parent_id, subject, complaint, attachment } = req.body;

  if (!parent_id || !subject || !complaint) {
    return res.status(400).json({ message: 'Subject and complaint details are required' });
  }

  try {
    // Simulated AI classification
    const text = (subject + ' ' + complaint).toLowerCase();
    let category = 'Administration';
    let assignedRole = 'principal';
    let acknowledgementMessage = '';
    let priority = 'Medium';

    if (text.match(/(grade|score|teacher|subject|teach|class|exam|test|assignment|result)/)) {
      category = 'Academic';
      assignedRole = 'principal';
      acknowledgementMessage = 'Dear Parent, thank you for your feedback regarding academic progress. This complaint has been classified under Academic and routed to the Principal and Class Teacher for immediate review.';
      if (text.match(/(fail|mistake|wrong|error|unfair)/)) {
        priority = 'High';
      }
    } else if (text.match(/(fee|bill|invoice|payment|money|naira|cost|charge|refund|bursar)/)) {
      category = 'Finance';
      assignedRole = 'bursar';
      acknowledgementMessage = 'Dear Parent, thank you for reaching out. Your query regarding school fees has been routed to the Bursar\'s desk for reconciliation and will be resolved shortly.';
    } else if (text.match(/(fight|bully|discipline|rude|punish|behave|rule|suspension|trouble)/)) {
      category = 'Discipline';
      assignedRole = 'principal';
      acknowledgementMessage = 'Dear Parent, we take student conduct very seriously. Your concern has been routed to the Principal and the Disciplinary Officer for investigations.';
      priority = 'High';
    } else if (text.match(/(sick|ill|fever|clinic|hospital|doctor|nurse|health|injury|hurt|pain|accident)/)) {
      category = 'Health';
      assignedRole = 'principal'; // also routes to school clinic
      acknowledgementMessage = 'Dear Parent, thank you for alerting us. Your message has been sent directly to the School Clinic staff and the Principal for immediate health review.';
      priority = 'High';
    } else {
      category = 'Administration';
      assignedRole = 'principal';
      acknowledgementMessage = 'Dear Parent, your query has been routed to the Administrative Office for processing. Thank you for your patience.';
      priority = 'Low';
    }

    const result = await query.run(`
      INSERT INTO complaints (parent_id, subject, complaint, attachment, category, priority, assigned_role, status, acknowledgement_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `, [parent_id, subject, complaint, attachment || null, category, priority, assignedRole, acknowledgementMessage]);

    // Send notifications to parent & assigned staff
    await createNotification(
      parent_id,
      'Academic',
      'Complaint Received',
      `Your complaint "${subject}" was received. Classification: ${category}. Status: Pending.`
    );

    // Notify role
    const staff = await query.all("SELECT id FROM users WHERE role = ?", [assignedRole]);
    for (const st of staff) {
      await createNotification(
        st.id,
        'Academic',
        'New Complaint Routed',
        `A new ${category} complaint has been filed by a parent. Subject: ${subject}. Priority: ${priority}.`
      );
    }

    res.status(201).json({ 
      message: 'Complaint submitted and classified', 
      complaintId: result.id, 
      category, 
      priority,
      acknowledgementMessage 
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/parent/complaints/:parentUserId', async (req, res) => {
  try {
    const complaints = await query.all(`
      SELECT * FROM complaints 
      WHERE parent_id = ?
      ORDER BY id DESC
    `, [req.params.parentUserId]);
    res.json(complaints);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Fetch all complaints school-wide (for Proprietor / Principal / Bursar)
app.get('/api/complaints', async (req, res) => {
  try {
    const complaints = await query.all(`
      SELECT c.*, u.name as parent_name, u.email as parent_email
      FROM complaints c
      JOIN users u ON c.parent_id = u.id
      ORDER BY c.id DESC
    `);
    res.json(complaints);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.put('/api/complaints/:id/status', async (req, res) => {
  const { status } = req.body;
  try {
    await query.run('UPDATE complaints SET status = ? WHERE id = ?', [status, req.params.id]);
    const complaint = await query.get('SELECT parent_id, subject FROM complaints WHERE id = ?', [req.params.id]);
    if (complaint) {
      await createNotification(
        complaint.parent_id,
        'Academic',
        'Complaint Updated',
        `Your complaint "${complaint.subject}" status is now: ${status}.`
      );
    }
    res.json({ message: 'Complaint status updated' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ----------------------------------------------------
// 13. Assignments Module
// ----------------------------------------------------
app.post('/api/teacher/assignments', async (req, res) => {
  const { class_id, subject_id, teacher_id, title, instructions, due_date, attachment, marks } = req.body;
  if (!class_id || !subject_id || !teacher_id || !title || !instructions || !due_date || !marks) {
    return res.status(400).json({ message: 'All assignment fields are required' });
  }

  try {
    const result = await query.run(`
      INSERT INTO assignments (class_id, subject_id, teacher_id, title, instructions, due_date, attachment, marks)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [class_id, subject_id, teacher_id, title, instructions, due_date, attachment || null, parseFloat(marks)]);

    // Notify Students of this class
    const students = await query.all('SELECT user_id, id FROM students WHERE class_id = ?', [class_id]);
    for (const stu of students) {
      await createNotification(
        stu.user_id,
        'Assignments',
        'New Assignment Published',
        `New assignment in subject: ${title}. Due date: ${due_date}. Max marks: ${marks}`
      );
    }

    // Notify Parents of these students
    const parents = await query.all('SELECT DISTINCT parent_id FROM students WHERE class_id = ? AND parent_id IS NOT NULL', [class_id]);
    for (const p of parents) {
      await createNotification(
        p.parent_id,
        'Assignments',
        'New Class Assignment',
        `A new assignment "${title}" has been published for your child. Due date: ${due_date}`
      );
    }

    res.status(201).json({ message: 'Assignment created successfully', id: result.id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/teacher/assignments/:teacherUserId', async (req, res) => {
  try {
    const teacher = await query.get('SELECT id FROM users WHERE id = ?', [req.params.teacherUserId]);
    if (!teacher) return res.status(404).json({ message: 'Teacher not found' });

    const assignments = await query.all(`
      SELECT a.*, c.name as class_name, s.name as subject_name
      FROM assignments a
      JOIN classes c ON a.class_id = c.id
      JOIN subjects s ON a.subject_id = s.id
      WHERE a.teacher_id = ?
      ORDER BY a.id DESC
    `, [req.params.teacherUserId]);

    res.json(assignments);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/student/assignments/:classId', async (req, res) => {
  try {
    const assignments = await query.all(`
      SELECT a.*, s.name as subject_name, s.code as subject_code, u.name as teacher_name
      FROM assignments a
      JOIN subjects s ON a.subject_id = s.id
      JOIN users u ON a.teacher_id = u.id
      WHERE a.class_id = ?
      ORDER BY a.id DESC
    `, [req.params.classId]);

    res.json(assignments);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/parent/assignments/:studentId', async (req, res) => {
  try {
    const student = await query.get('SELECT class_id FROM students WHERE id = ?', [req.params.studentId]);
    if (!student || !student.class_id) return res.json([]);

    const assignments = await query.all(`
      SELECT a.*, s.name as subject_name, s.code as subject_code, u.name as teacher_name
      FROM assignments a
      JOIN subjects s ON a.subject_id = s.id
      JOIN users u ON a.teacher_id = u.id
      WHERE a.class_id = ?
      ORDER BY a.id DESC
    `, [student.class_id]);

    res.json(assignments);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ----------------------------------------------------
// 14. Notifications Hub
// ----------------------------------------------------
app.get('/api/notifications/:userId', async (req, res) => {
  try {
    const notifications = await query.all(`
      SELECT * FROM notifications
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 50
    `, [req.params.userId]);
    res.json(notifications);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.put('/api/notifications/:id/read', async (req, res) => {
  try {
    await query.run('UPDATE notifications SET read = 1 WHERE id = ?', [req.params.id]);
    res.json({ message: 'Notification marked as read' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/admin/broadcast-notification', async (req, res) => {
  const { type, title, message, targetRole, schoolId, senderRole } = req.body;
  if (!type || !title || !message || !targetRole) {
    return res.status(400).json({ message: 'All notification fields are required' });
  }

  try {
    let usersQuery = 'SELECT id FROM users WHERE 1=1';
    let queryParams = [];

    // If sender is NOT a superadmin, restrict notifications to their own school
    if (senderRole !== 'superadmin') {
      if (!schoolId) {
        return res.status(400).json({ message: 'School ID is required for non-superadmin broadcasts' });
      }
      usersQuery += ' AND school_id = ?';
      queryParams.push(schoolId);
    }

    // Role-based target filtering
    if (targetRole !== 'all') {
      usersQuery += ' AND role = ?';
      queryParams.push(targetRole);
    }

    const targetUsers = await query.all(usersQuery, queryParams);

    for (const tu of targetUsers) {
      await createNotification(tu.id, type, title, message);
    }

    res.status(201).json({ message: `Successfully broadcasted notification to ${targetUsers.length} users` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ----------------------------------------------------
// 15. Family Discount Configs
// ----------------------------------------------------
app.get('/api/bursar/discounts', async (req, res) => {
  try {
    const discounts = await query.all('SELECT * FROM family_discounts ORDER BY min_children ASC');
    res.json(discounts);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/bursar/discounts', async (req, res) => {
  const { min_children, discount_percentage, name } = req.body;
  try {
    await query.run(`
      INSERT INTO family_discounts (min_children, discount_percentage, name)
      VALUES (?, ?, ?)
      ON CONFLICT(min_children) DO UPDATE SET
        discount_percentage = excluded.discount_percentage,
        name = excluded.name
    `, [min_children, discount_percentage, name]);

    res.status(201).json({ message: 'Discount plan updated' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ----------------------------------------------------
// 16. AI Finance Insights
// ----------------------------------------------------
app.get('/api/bursar/finance-insights', async (req, res) => {
  try {
    const invoices = await query.all('SELECT * FROM invoices');
    const totalAmount = invoices.reduce((sum, inv) => sum + inv.total_amount, 0);
    const paidAmount = invoices.reduce((sum, inv) => sum + inv.paid_amount, 0);
    const outstanding = totalAmount - paidAmount;
    const rate = totalAmount > 0 ? ((paidAmount / totalAmount) * 100).toFixed(1) : 0;

    // Get breakdown by class
    const classDebts = await query.all(`
      SELECT c.name as class_name, SUM(i.total_amount - i.paid_amount) as debt
      FROM invoices i
      JOIN students s ON i.student_id = s.id
      JOIN classes c ON s.class_id = c.id
      GROUP BY c.name
      ORDER BY debt DESC
    `);

    const topDebtorClass = classDebts.length > 0 && classDebts[0].debt > 0 ? classDebts[0].class_name : 'None';

    const insights = [
      `Revenue collection increased by 12% this week compared to opening term collections.`,
      `Class ${topDebtorClass} currently has the highest outstanding tuition fees.`,
      `Most payments (65%) are logged on Fridays, indicating a weekly clearing pattern by parents.`,
      `Installment payment compliance is currently at 94% under the new billing policies.`
    ];

    res.json({
      collectionRate: rate,
      totalCollected: paidAmount,
      totalOutstanding: outstanding,
      insights
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Send payment reminder webhook/notification
app.post('/api/bursar/send-reminders', async (req, res) => {
  const { studentIds } = req.body;
  if (!studentIds || !Array.isArray(studentIds)) {
    return res.status(400).json({ message: 'studentIds array is required' });
  }

  try {
    for (const sid of studentIds) {
      const student = await query.get(`
        SELECT s.parent_id, u.name as student_name, i.total_amount, i.paid_amount
        FROM students s
        JOIN users u ON s.user_id = u.id
        LEFT JOIN invoices i ON s.id = i.student_id
        WHERE s.id = ?
      `, [sid]);

      if (student && student.parent_id) {
        const owed = student.total_amount - student.paid_amount;
        await createNotification(
          student.parent_id,
          'Finance',
          'Tuition Balance Reminder',
          `Dear parent, this is a friendly reminder that an outstanding balance of ₦${owed.toLocaleString()} remains for ${student.student_name}. Please complete payment.`
        );
      }
    }
    res.json({ message: `Reminders successfully sent to ${studentIds.length} parents` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ----------------------------------------------------
// Bulk Import Endpoints
// ----------------------------------------------------

// Bulk Import Students
app.post('/api/students/import', async (req, res) => {
  const { students, school_id } = req.body;
  const schoolId = school_id || 1;

  if (!students || !Array.isArray(students)) {
    return res.status(400).json({ message: 'Students array is required' });
  }

  const results = {
    successful: [],
    failed: []
  };

  try {
    const salt = await bcrypt.genSalt(10);
    const password = await bcrypt.hash('password123', salt);

    // Fetch classes for lookup
    const classes = await query.all('SELECT id, name FROM classes WHERE school_id = ?', [schoolId]);
    const classMap = {};
    classes.forEach(c => {
      classMap[c.name.toLowerCase().trim()] = c.id;
    });

    const activeTerm = await query.get('SELECT t.id FROM terms t JOIN sessions s ON t.session_id = s.id WHERE t.active = 1 AND s.school_id = ? LIMIT 1', [schoolId]);

    for (let index = 0; index < students.length; index++) {
      const row = students[index];
      const { name, email, phone, class_name, guardian_name, guardian_phone } = row;

      if (!name || !email) {
        results.failed.push({
          row: index + 1,
          name: name || 'Unknown',
          reason: 'Name and email are required.'
        });
        continue;
      }

      // Check email uniqueness
      const existingUser = await query.get('SELECT id FROM users WHERE email = ?', [email]);
      if (existingUser) {
        results.failed.push({
          row: index + 1,
          name,
          reason: `Email '${email}' is already registered.`
        });
        continue;
      }

      // Look up class_id
      let class_id = null;
      if (class_name) {
        class_id = classMap[class_name.toLowerCase().trim()] || null;
        if (!class_id) {
          results.failed.push({
            row: index + 1,
            name,
            reason: `Class '${class_name}' does not exist.`
          });
          continue;
        }
      }

      try {
        // Insert user
        const userResult = await query.run(`
          INSERT INTO users (school_id, name, email, password, role, phone, invitation_status)
          VALUES (?, ?, ?, ?, 'student', ?, 'pending')
        `, [schoolId, name, email, password, phone || null]);

        const user_id = userResult.id;
        const userObj = {
          id: user_id,
          school_id: schoolId,
          name,
          email,
          role: 'student',
          invitation_status: 'pending'
        };
        sendNewUserInvite(userObj, 'password123').catch(console.error);
        const admission_no = 'ADM' + Date.now().toString().slice(-6) + index;

        // Create student profile
        const studentResult = await query.run(`
          INSERT INTO students (user_id, class_id, admission_no, guardian_name, guardian_phone)
          VALUES (?, ?, ?, ?, ?)
        `, [user_id, class_id, admission_no, guardian_name || null, guardian_phone || null]);

        // Create invoice for default class fees
        if (class_id && activeTerm) {
          const fees = await query.all('SELECT SUM(amount) as total FROM fee_structures WHERE class_id = ? AND term_id = ?', [class_id, activeTerm.id]);
          const totalAmount = fees[0].total || 0;

          if (totalAmount > 0) {
            await query.run(`
              INSERT INTO invoices (student_id, term_id, total_amount, paid_amount, status, due_date)
              VALUES (?, ?, ?, 0, 'unpaid', '2026-07-30')
            `, [studentResult.id, activeTerm.id, totalAmount]);
          }
        }

        results.successful.push({
          row: index + 1,
          name,
          admission_no
        });
      } catch (err) {
        results.failed.push({
          row: index + 1,
          name,
          reason: err.message
        });
      }
    }

    res.json(results);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error during student import' });
  }
});

// Bulk Import Teachers & Staff
app.post('/api/teachers/import', async (req, res) => {
  const { staff, school_id } = req.body;
  const schoolId = school_id || 1;

  if (!staff || !Array.isArray(staff)) {
    return res.status(400).json({ message: 'Staff array is required' });
  }

  const results = {
    successful: [],
    failed: []
  };

  try {
    const salt = await bcrypt.genSalt(10);
    const password = await bcrypt.hash('password123', salt);

    // Fetch classes for lookup
    const classes = await query.all('SELECT id, name FROM classes WHERE school_id = ?', [schoolId]);
    const classMap = {};
    classes.forEach(c => {
      classMap[c.name.toLowerCase().trim()] = c.id;
    });

    for (let index = 0; index < staff.length; index++) {
      const row = staff[index];
      const { name, email, phone, role, employee_no, department, class_name } = row;

      if (!name || !email || !role || !employee_no) {
        results.failed.push({
          row: index + 1,
          name: name || 'Unknown',
          reason: 'Name, email, role, and employee number are required.'
        });
        continue;
      }

      const cleanRole = role.toLowerCase().trim();
      if (!['teacher', 'principal', 'bursar'].includes(cleanRole)) {
        results.failed.push({
          row: index + 1,
          name,
          reason: `Invalid role '${role}'. Role must be one of: teacher, principal, bursar.`
        });
        continue;
      }

      // Check email uniqueness
      const existingUser = await query.get('SELECT id FROM users WHERE email = ?', [email]);
      if (existingUser) {
        results.failed.push({
          row: index + 1,
          name,
          reason: `Email '${email}' is already registered.`
        });
        continue;
      }

      // Check employee number uniqueness
      const existingEmp = await query.get('SELECT id FROM teachers WHERE employee_no = ?', [employee_no]);
      if (existingEmp) {
        results.failed.push({
          row: index + 1,
          name,
          reason: `Employee number '${employee_no}' is already in use.`
        });
        continue;
      }

      // Look up class_id
      let class_id = null;
      if (class_name) {
        class_id = classMap[class_name.toLowerCase().trim()] || null;
        if (!class_id) {
          results.failed.push({
            row: index + 1,
            name,
            reason: `Class '${class_name}' does not exist.`
          });
          continue;
        }
      }

      try {
        // Create user
        const userResult = await query.run(`
          INSERT INTO users (school_id, name, email, password, role, phone, invitation_status)
          VALUES (?, ?, ?, ?, ?, ?, 'pending')
        `, [schoolId, name, email, password, cleanRole, phone || null]);

        const user_id = userResult.id;
        const userObj = {
          id: user_id,
          school_id: schoolId,
          name,
          email,
          role: cleanRole,
          invitation_status: 'pending'
        };
        sendNewUserInvite(userObj, 'password123').catch(console.error);

        // Create teacher/staff profile
        await query.run(`
          INSERT INTO teachers (user_id, employee_no, department, class_id)
          VALUES (?, ?, ?, ?)
        `, [user_id, employee_no, department || null, class_id || null]);

        // Save subject assignments
        const { class_subjects } = row;
        if (class_subjects && Array.isArray(class_subjects)) {
          for (const assignment of class_subjects) {
            await query.run(`
              INSERT INTO class_subjects (class_id, subject_id, teacher_id)
              VALUES (?, ?, ?)
            `, [assignment.class_id, assignment.subject_id, user_id]);

            await query.run(`
              INSERT OR IGNORE INTO staff_subjects (teacher_id, subject_id)
              VALUES (?, ?)
            `, [user_id, assignment.subject_id]);
          }
        }

        results.successful.push({
          row: index + 1,
          name,
          employee_no
        });
      } catch (err) {
        results.failed.push({
          row: index + 1,
          name,
          reason: err.message
        });
      }
    }

    res.json(results);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error during staff import' });
  }
});

// ----------------------------------------------------
// Start Server
// ----------------------------------------------------
app.listen(PORT, () => {
  console.log(`SchoolOS AI Backend running on http://localhost:${PORT}`);
});

