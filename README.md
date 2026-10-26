# RESILIO
### Smart inventory smooth queue

## 📌 About Project
RESILIO is a Self Healing restaurant management system designed to manage restaurant operations and handle failures through detection, recovery, and verification mechanisms.

## 🛠️ Technology Stack
- **Frontend:** React.js, Vite, Tailwind CSS
- **Backend:** Node.js, Express.js
- **Database:** MongoDB Atlas
- **Offline Storage:** IndexedDB

## ✨ Main Features
- Customer Interface and Order Management
- Stock Inventory Management
- Ingredient and Supplier Management
- Stock Batch and Expiry Tracking
- Inventory Reports and Alerts
- Self-Healing Monitoring
- Offline Inventory Recovery
- Queue and Token Management

## 🔄 Failure Scenarios

### 1. Duplicate Token Failure
Addresses duplicate token creation through request validation and duplicate-checking mechanisms.

### 2. Queue Status Synchronization Failure
Addresses inconsistencies between queue statuses and helps restore synchronization with the latest backend state.

### 3. Expired Stock Detection
Identifies expired inventory batches and supports updating their status, removing expired quantities from usable stock, and generating admin alerts.

### 4. Offline Inventory Recovery
Stores pending inventory operations locally during network interruptions and synchronizes them with the backend after connectivity is restored.

## ⚙️ Self-Healing Workflow
1. Failure Injection
2. Failure Detection
3. Recovery Action
4. Recovery Verification
5. Final Status

## 🚀 Installation

**Clone the repository:**
```bash
git clone https://github.com/Deepika-sharma2008/Resilio.git
cd Resilio
```

Install dependencies in the backend and frontend directories:

```bash
npm install
```

Start each application using the scripts defined in its respective `package.json` file.

Configure the required environment variables before starting the backend.

## 🧪 Testing
Failures are tested in a controlled development environment. Recovery is verified using application logs, inventory records, and final database states.

## 🎯 Objective
To improve restaurant system reliability through failure detection, recovery mechanisms, and data consistency verification.

## 👥 Project
**RESILIO — Resilient Restaurant Management System**
