import axios from 'axios';
import ErrorHandler from '../utils/handlers/errorHandler';



const api = axios.create({
    baseURL: 'http://localhost:5000/api',
    timeout: 30000,
    headers: {
        'Content-Type': 'application/json'
    }
});

// Request interceptor
api.interceptors.request.use(
    (config) => {
        console.log(`Making ${config.method.toUpperCase()} request to: ${config.url}`);
        const token = localStorage.getItem('adminToken');
        if (token) {
            config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
    },
    (error) => {
        console.error('Request interceptor error:', error);
        return ErrorHandler.handle(error);
    }
);

// Response interceptor
api.interceptors.response.use(
    (response) => response.data,
    (error) => {
        if (error.code === 'ECONNABORTED') {
            console.error('Connection timeout. Please check if your server is running at http://localhost:5000');
        } else if (!error.response) {
            console.error('Network error. Please check your server connection');
        }
        return ErrorHandler.handle(error);
    }
);



const apiService = {
    // Dashboard Statistics
    getDashboardStats: async () => {
        try {
            const [students, parents, teachers] = await Promise.all([
                api.get('/student-apply/all'),
                api.get('/parent-apply/all'),
                api.get('/teacher-apply/all')
            ]);

            return {
                students: students.data.length,
                parents: parents.data.length,
                teachers: {
                    total: teachers.data.length,
                    pending: teachers.data.filter(t => t.status === 'pending').length,
                    approved: teachers.data.filter(t => t.status === 'approved').length,
                    rejected: teachers.data.filter(t => t.status === 'rejected').length
                }
            };
        } catch (error) {
            throw error;
        }
    },

    // Teachers
    getAllTeachers: async () => {
        try {
          // Get direct signups - update the endpoint to match your backend
          const directSignups = await api.get('/teacher-apply/all');
          
          // Get vacancy applications
          const vacancies = await api.get('/vacancies');
          const applicants = new Map();
          
          if (Array.isArray(vacancies)) {
            vacancies.forEach(vacancy => {
              if (vacancy.applications) {
                vacancy.applications.forEach(app => {
                  if (app.teacher && !applicants.has(app.teacher._id)) {
                    applicants.set(app.teacher._id, {
                      _id: app.teacher._id,
                      fullName: app.teacher.fullName,
                      email: app.teacher.email,
                      phone: app.teacher.phone,
                      status: app.status,
                      cv: app.teacher.cv,
                      subjects: app.teacher.subjects || [],
                      fees: app.teacher.fees,
                      appliedAt: app.appliedAt,
                      isVacancyApplication: true
                    });
                  }
                });
              }
            });
          }
          
          // Combine both types of teachers
          const allTeachers = [
            ...(directSignups?.data || []).map(teacher => ({ ...teacher, isDirectSignup: true })),
            ...Array.from(applicants.values())
          ];
      
          console.log('All teachers:', allTeachers);
          return allTeachers;
        } catch (error) {
          console.error('Error fetching all teachers:', error);
          throw error;
        }
      },

    

    getTeacherCV: async (teacherId) => {
        const response = await api.get(`/teacher-apply/${teacherId}/cv`);
        return response.data;
    },

    updateTeacherStatus: async (teacherId, status) => {
        try {
            // First get all vacancies to find the application
            const vacancies = await api.get('/vacancies');
            
            // Find the vacancy containing this teacher's application
            let targetVacancy = null;
            let applicationId = null;
            
            for (const vacancy of vacancies) {
                if (vacancy.applications) {
                    const application = vacancy.applications.find(app => 
                        app.teacher && app.teacher._id === teacherId
                    );
                    if (application) {
                        targetVacancy = vacancy;
                        applicationId = application._id;
                        break;
                    }
                }
            }
            
            if (!targetVacancy) {
                throw new Error('Teacher application not found');
            }
            
            console.log('Updating status for:', { teacherId, status });
            const response = await api.put(`/teacher-apply/${teacherId}/status`, { status });
            
            
            console.log('Status update response:', response);
            return response;
        } catch (error) {
            console.error('Error updating teacher status:', error);
            throw error;
        }
    },

    // Students
    getAllStudents: async () => {
        try {
            const response = await api.get('/student-apply/all');
            return response.data;
        } catch (error) {
            throw error;
        }
    },

    deleteStudent: async (id) => {
        try {
            const response = await api.delete(`/student-apply/delete/${id}`);
            return response.data;
        } catch (error) {
            throw error;
        }
    },

    // Parents
    getAllParents: async () => {
        const response = await api.get('/parent-apply/all');
        return response.data;
    },

    deleteParent: async (id) => {
        const response = await api.delete(`/parent-apply/delete/${id}`);
        return response.data;
    },

    // Auth
    // Auth
    login: async (credentials) => {
        try {
            console.log('Login attempt with username:', credentials.username);
            
            // Validate credentials
            if (!credentials.username || !credentials.password) {
                throw new Error('Username and password are required');
            }
    
            const response = await api.post('/admin/login', credentials);
            console.log('Login response:', response);
    
            // Check for success flag
            if (!response.success) {
                throw new Error(response.message || 'Login failed');
            }
    
            // Validate token
            if (!response.token) {
                throw new Error('No token received from server');
            }
    
            // Store token
            localStorage.setItem('adminToken', response.token);
            
            return {
                token: response.token,
                admin: response.admin
            };
        } catch (error) {
            console.error('Login error:', {
                message: error.message,
                response: error.response?.data,
                status: error.response?.status
            });
            
            // Handle specific error cases
            if (error.response?.status === 401) {
                throw new Error('Invalid username or password');
            } else if (error.response?.status === 400) {
                throw new Error('Please provide both username and password');
            } else {
                throw new Error(
                    error.response?.data?.message || 
                    error.message || 
                    'Login failed. Please try again.'
                );
            }
        }
    },

    logout: () => {
        localStorage.removeItem('adminToken');
        window.location.href = '/login';
    },



    getAllVacancies: async () => {
        try {
          console.log('Fetching all vacancies...');
          const response = await api.get('/vacancies');
          console.log('All vacancies response:', response);
          return Array.isArray(response) ? response.map(vacancy => ({
            ...vacancy,
            featured: vacancy.featured || false
          })) : [];
        } catch (error) {
          console.error('Error fetching all vacancies:', error);
          throw error;
        }
      },

    createVacancy: async (data) => {
        try {
            const response = await api.post('/vacancies', {
                title: data.title,
                subject: data.subject,
                description: data.description,
                requirements: data.requirements,
                salary: data.salary,
                status: 'open',
                featured: data.featured || false
            });
            return response;
        } catch (error) {
            console.error('Error creating vacancy:', error);
            throw error;
        }
    },

    updateVacancy: async (id, data) => {
        try {
            console.log('Updating vacancy:', { id, data });
            const response = await api.put(`/vacancies/${id}`, data);
            console.log('Update response:', response);
            return response;
        } catch (error) {
            console.error('Error updating vacancy:', error);
            throw error;
        }
    },

    deleteVacancy: async (id) => {
        try {
            const isConfirmed = window.confirm('Are you sure you want to delete this vacancy?');
            
            if (!isConfirmed) {
                return null;
            }
            
            const response = await api.delete(`/vacancies/${id}`);
            return response;
        } catch (error) {
            console.error('Error deleting vacancy:', error);
            throw error;
        }
    },

    updateVacancyStatus: async (id, status) => {
        try {
            const response = await api.patch(`/vacancies/${id}/status`, { status });
            return response;
        } catch (error) {
            console.error('Error updating vacancy status:', error);
            throw error;
        }
    },

    getVacancyApplicants: async (vacancyId) => {
        try {
          console.log('Fetching applicants for vacancy:', vacancyId);
          const response = await api.get(`/vacancies/${vacancyId}/applicants`);
          console.log('Applicants response:', response);
          return response || [];
        } catch (error) {
          console.error('Error fetching vacancy applicants:', error);
          throw error;
        }
      },
  
// Add this method if not already present
// Update this method in api.js
getTeachersByStatus: async (status) => {
    try {
      const response = await api.get(`/teacher-apply/status/${status}`);
      console.log(`Teachers with ${status} status:`, response);
      return response;
    } catch (error) {
      console.error('Error fetching teachers by status:', error);
      throw error;
    }
  },

  // Add these new methods for featured vacancies
  updateVacancyFeatured: async (id, featured) => {
    try {
      console.log('Updating vacancy featured status:', { id, featured });
      const response = await api.put(`/vacancies/${id}`, { featured });
      return response;
    } catch (error) {
      console.error('Error updating vacancy featured status:', error);
      throw error;
    }
  },

  getFeaturedVacancies: async () => {
    try {
      console.log('Fetching featured vacancies...');
      const response = await api.get('/vacancies/featured');
      console.log('Featured vacancies response:', response);
      return response.data || [];
    } catch (error) {
      console.error('Error fetching featured vacancies:', error);
      throw error;
    }
  }

};





export default apiService;