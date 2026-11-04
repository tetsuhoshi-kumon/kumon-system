# Kumon Center Management System

A production-ready management system for Kumon centers featuring:
- **Barcode & Kiosk Check-In / Check-Out** with 30s cooldown prevention and visual scan toast banners.
- **Active Students Dashboard** with real-time animated color progress bars (30m / 60m targets).
- **Lobby Board** displaying ready-for-pickup and currently studying students.
- **Student & Staff ID Badges** formatted for Avery 5160/8160 printing with customizable start-slot offsets.
- **Book Library Circulation**:
  - Auto-generating unique book IDs (`BK-{LEVEL}-{TIMESTAMP}-{RAND}`).
  - Natural integer sorting (ensuring `5` & `6` precede `11`).
  - Book sticker layout showing `LEVEL - NUMBER`, Title, Author, ID, and scannable QR code.
  - Autocomplete search for book titles and student names.
  - Interactive Student Reading History modal.
  - 14-day overdue badges with parent contact quick-links.
  - CSV catalog and circulation history export.
- **Staff Shift Logs & Payroll Auditing**:
  - Retroactive departure time inputs.
  - Shift log inspection, inline hours correction, and cycle resets.
- **Automatic MongoDB Atlas Repair**:
  - Auto-drops legacy unique indexes on collection initialization to prevent `E11000` errors.

## Quick Start

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the server:
   ```bash
   npm start
   ```

3. Deploy to Render:
   ```bash
   git add server.js public/index.html
   git commit -m "Update Kumon system with latest features"
   git push origin main
   ```
