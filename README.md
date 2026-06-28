# SchoolOS AI Backend

The backend REST API server for SchoolOS. Built with Node.js, Express, and SQLite.

## Features

- **Authentication & Invitations**: Token-based JWT authorization and verification.
- **School Management**: Automated registration for classes, courses, and students.
- **Teacher Assignments**: Support for class-subject assignments mapping and class teachers.
- **SQLite Database Integration**: Lightweight relational database storage with automatic schema startup migrations.

## Getting Started

### Prerequisites

- Node.js (v18.0.0 or later)
- npm (Node Package Manager)

### Installation

1. Navigate to the backend directory:
   ```bash
   cd backend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

### Database Seeding

To clean the local SQLite database and populate it with initial seed data (including classes, subjects, demo accounts for proprietor, bursar, teachers, and students):
```bash
node src/config/seed.js
```

### Running the Server

Start the development server:
```bash
node src/app.js
```
The server runs on **http://localhost:5000**.

## Configuration & Environment

You can configure the following environment variables (defaults are active out of the box):
- `PORT`: Port to run the server on (default: `5000`).
- `JWT_SECRET`: Token signature secret (default: `jwt_secret_key`).
- Database location is relative at: `backend/schoolos.db`.
