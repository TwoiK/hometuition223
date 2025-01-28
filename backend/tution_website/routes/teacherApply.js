const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { 
    signup, 
    login, 
    checkRegistration, 
    resetPasswordRequest, 
    getProfile,
    acceptTeacherApplication,    
    rejectTeacherApplication,   
    updateVacancyStatus         
} = require('../controllers/teacherApplyController');
const authMiddleware = require('../middleware/auth');

const Vacancy = require('../models/Vacancy');
const Teacher = require('../models/TeacherApply');
const { broadcastUpdate } = require('../server');
const cloudinary = require('cloudinary').v2;
const fs = require('fs');  // Regular fs for sync operations
const fsp = require('fs').promises;  // Promise-based fs for async operations

// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Define allowed file types
const ALLOWED_TYPES = {
    'cv': ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    'certificates': ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/jpeg', 'image/png']
};

// Configure multer storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // Ensure uploads directory exists
        const uploadDir = path.join(__dirname, '..', 'uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname)}`);
    }
});

// File filter function
const fileFilter = (req, file, cb) => {
    if (!ALLOWED_TYPES[file.fieldname]) {
        cb(new Error(`Unexpected field: ${file.fieldname}`), false);
        return;
    }

    if (!ALLOWED_TYPES[file.fieldname].includes(file.mimetype)) {
        cb(new Error(`Invalid file type for ${file.fieldname}. Allowed types: ${ALLOWED_TYPES[file.fieldname].join(', ')}`), false);
        return;
    }

    cb(null, true);
};

// Configure multer
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 2 * 1024 * 1024, // 2MB limit
        files: 6 // Maximum number of files (1 CV + 5 certificates)
    },
    fileFilter: fileFilter
});

// Error handling middleware for multer
const handleMulterError = (err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        switch (err.code) {
            case 'LIMIT_FILE_SIZE':
                return res.status(400).json({
                    success: false,
                    message: 'File size exceeds 2MB limit',
                    error: err.code
                });
            case 'LIMIT_FILE_COUNT':
                return res.status(400).json({
                    success: false,
                    message: 'Too many files uploaded',
                    error: err.code
                });
            default:
                return res.status(400).json({
                    success: false,
                    message: `Upload error: ${err.message}`,
                    error: err.code
                });
        }
    }
    
    if (err) {
        return res.status(400).json({
            success: false,
            message: err.message
        });
    }
    
    next();
};

// Routes
router.post('/signup', 
    upload.fields([
        { name: 'cv', maxCount: 1 },
        { name: 'certificates', maxCount: 5 }
    ]),
    async (req, res) => {
        try {
            // Upload CV to Cloudinary
            const cvFile = req.files?.cv?.[0];
            if (!cvFile) {
                return res.status(400).json({
                    success: false,
                    message: 'CV file is required'
                });
            }

            // Upload to Cloudinary
            const cvResult = await cloudinary.uploader.upload(cvFile.path, {
                resource_type: 'raw',
                folder: 'teacher_cvs',
            });

            // Clean up the local file
            await fsp.unlink(cvFile.path);

            // Add the CV URL to the request body
            req.body.cvUrl = cvResult.secure_url;

            // Call the signup controller
            await signup(req, res);

        } catch (error) {
            console.error('Route Error:', error);
            
            // Clean up any uploaded files
            if (req.files?.cv?.[0]) {
                try {
                    await fsp.unlink(req.files.cv[0].path);
                } catch (err) {
                    console.warn('Failed to delete local file:', err);
                }
            }

            res.status(500).json({
                success: false,
                message: 'Error processing signup',
                error: process.env.NODE_ENV === 'development' ? error.message : 'Server error'
            });
        }
    }
);

router.post('/login', login);
router.get('/check-registration', checkRegistration);
router.post('/reset-password', resetPasswordRequest);

// GET available vacancies
router.get('/available-vacancies', async (req, res) => {
  try {
    const vacancies = await Vacancy.find({ 
      status: 'open',    // Changed to lowercase to match database
      featured: true     // Only get featured vacancies
    })
    .select('title subject description requirements salary status createdAt')
    .lean()
    .sort({ createdAt: -1 });
    
    console.log('Query conditions:', { status: 'open', featured: true }); // Debug log
    console.log('Found featured vacancies:', vacancies.length);
    console.log('Vacancies:', JSON.stringify(vacancies, null, 2)); // Pretty print vacancies
   
    res.json({
      success: true,
      vacancies: vacancies
    });
  } catch (error) {
    console.error('Error fetching available vacancies:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching available vacancies',
      error: error.message
    });
  }
});

// Protected routes (auth required)
router.get('/profile', authMiddleware, getProfile);
router.put('/accept/:teacherId/:vacancyId', authMiddleware, acceptTeacherApplication);
router.put('/reject/:teacherId/:vacancyId', authMiddleware, rejectTeacherApplication);
router.put('/vacancy-status/:parentId', authMiddleware, updateVacancyStatus);
router.post('/apply-vacancy/:id', authMiddleware, async (req, res) => {
    try {
        const vacancyId = req.params.id;
        const teacherId = req.user._id;

        // Find and update the vacancy in one operation
        const vacancy = await Vacancy.findOneAndUpdate(
            { 
                _id: vacancyId,
                // Make sure vacancy doesn't already have this teacher's application
                'applications.teacher': { $ne: teacherId },
                // Make sure total applications is less than 2
                $expr: { $lt: [{ $size: '$applications' }, 2] }
            },
            {
                $push: {
                    applications: {
                        teacher: teacherId,
                        status: 'pending',
                        appliedAt: new Date()
                    }
                }
            },
            { 
                new: true,  // Return updated document
                runValidators: true  // Run schema validators
            }
        );

        if (!vacancy) {
            // Check why the vacancy wasn't updated
            const existingVacancy = await Vacancy.findById(vacancyId);
            if (!existingVacancy) {
                return res.status(404).json({
                    success: false,
                    message: 'Vacancy not found'
                });
            }

            if (existingVacancy.applications.some(app => app.teacher?.toString() === teacherId.toString())) {
                return res.status(400).json({
                    success: false,
                    message: 'You have already applied for this vacancy'
                });
            }

            if (existingVacancy.applications.length >= 2) {
                return res.status(400).json({
                    success: false,
                    message: 'This vacancy has reached maximum applications'
                });
            }

            return res.status(500).json({
                success: false,
                message: 'Unable to submit application'
            });
        }
        // Broadcast the new application
        broadcastUpdate('NEW_APPLICATION', {
            vacancy: vacancy,
            teacher: req.user,
            status: 'pending',
            appliedAt: new Date()
        });

        res.json({
            success: true,
            message: 'Application submitted successfully'
        });

      
    } catch (error) {
        console.error('Error applying for vacancy:', error);
        res.status(500).json({
            success: false,
            message: 'Error submitting application',
            error: error.message
        });
    }
});

// Get all teachers (both direct signups and vacancy applications)
router.get('/all', async (req, res) => {
    try {
      const teachers = await Teacher.find()
        .select('-password')
        .sort({ createdAt: -1 });
      
      res.json({
        success: true,
        data: teachers
      });
    } catch (error) {
      console.error('Error fetching teachers:', error);
      res.status(500).json({ 
        success: false, 
        message: 'Error fetching teachers',
        error: error.message 
      });
    }
  });
  
  // Get teachers by status
  router.get('/status/:status', async (req, res) => {
    try {
      const { status } = req.params;
      const teachers = await Teacher.find({ status })
        .select('-password')
        .sort({ createdAt: -1 });
      
      res.json({
        success: true,
        data: teachers
      });
    } catch (error) {
      console.error('Error fetching teachers by status:', error);
      res.status(500).json({ 
        success: false, 
        message: 'Error fetching teachers',
        error: error.message 
      });
    }
  });
  
  // Add this route to update teacher status
  router.put('/:id/status', async (req, res) => {
    try {
      const { status } = req.body;
      const teacher = await Teacher.findByIdAndUpdate(
        req.params.id,
        { status },
        { new: true }
      ).select('-password');
  
      if (!teacher) {
        return res.status(404).json({
          success: false,
          message: 'Teacher not found'
        });
      }
  
      res.json({
        success: true,
        data: teacher
      });
    } catch (error) {
      console.error('Error updating teacher status:', error);
      res.status(500).json({
        success: false,
        message: 'Error updating teacher status'
      });
    }
  });

// Add this route before module.exports
router.get('/my-applications', authMiddleware, async (req, res) => {
  try {
    console.log('Fetching applications for teacher:', req.user._id);
    
    // Find all vacancies where this teacher has applied
    const vacancies = await Vacancy.find({
      'applications.teacher': req.user._id
    })
    .select('title subject description requirements salary status applications')
    .lean();

    console.log('Found vacancies:', vacancies.length);

    // Format the applications data
    const applications = vacancies.map(vacancy => {
      const application = vacancy.applications.find(
        app => app.teacher.toString() === req.user._id.toString()
      );

      return {
        id: application._id,
        vacancy: {
          id: vacancy._id,
          title: vacancy.title,
          subject: vacancy.subject,
          description: vacancy.description,
          requirements: vacancy.requirements,
          salary: vacancy.salary,
          status: vacancy.status
        },
        status: application.status,
        appliedAt: application.appliedAt
      };
    });

    console.log('Formatted applications:', applications.length);

    res.json({
      success: true,
      applications: applications
    });

  } catch (error) {
    console.error('Error fetching applications:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching applications',
      error: error.message
    });
  }
});

// Add this route before module.exports
router.put('/update-profile', authMiddleware, upload.single('cv'), async (req, res) => {
  try {
    const { fullName, email, phone, subjects, fees } = req.body;
    const updates = {
      fullName,
      email,
      phone,
      subjects: subjects.split(',').map(s => s.trim()),
      fees
    };

    // If a new CV was uploaded
    if (req.file) {
      // Upload to Cloudinary
      const result = await cloudinary.uploader.upload(req.file.path, {
        resource_type: 'raw',
        folder: 'teacher_cvs',
      });
      
      // Add CV URL to updates
      updates.cv = result.secure_url;

      // Delete local file
      await fsp.unlink(req.file.path);
    }

    const teacher = await Teacher.findByIdAndUpdate(
      req.user._id,
      updates,
      { new: true }
    ).select('-password');

    if (!teacher) {
      return res.status(404).json({
        success: false,
        message: 'Teacher not found'
      });
    }

    res.json({
      success: true,
      message: 'Profile updated successfully',
      teacher
    });

  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating profile',
      error: error.message
    });
  }
});

// Create uploads directory at startup
const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
console.log('Uploads directory verified:', uploadDir);

// Add this route to check featured vacancies
router.get('/check-featured', async (req, res) => {
  try {
    const count = await Vacancy.countDocuments({
      featured: true,
      status: 'active'
    });

    console.log('Featured vacancies count:', count);

    res.json({
      success: true,
      count: count
    });
  } catch (error) {
    console.error('Error checking featured vacancies:', error);
    res.status(500).json({
      success: false,
      message: 'Error checking featured vacancies'
    });
  }
});

module.exports = router;