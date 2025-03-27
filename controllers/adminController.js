import jwt from 'jsonwebtoken'
import bcrypt from "bcrypt"
import appointmentModel from "../models/appointmentModel.js"
import doctorModel from "../models/doctorModel.js"
import userModel from "../models/userModel.js"
import validator from "validator"
import { v2 as cloudinary } from "cloudinary"
import { sendRegistrationEmail } from '../utils/emailService.js'
import { cancelPastAppointments } from '../utils/appointmentUtils.js'

// API for admin login
const loginAdmin = async (req, res) => {
    try {

        const { email, password } = req.body

        if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
            const token = jwt.sign(email + password, process.env.JWT_SECRET)
            res.json({ success: true, token })
        } else {
            res.json({ success: false, message: "Invalid credentials" })
        }

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }

}


// API to get all appointments list
const appointmentsAdmin = async (req, res) => {
    try {
        // First, auto-cancel any past appointments
        await cancelPastAppointments();

        const appointments = await appointmentModel.find({})
        res.json({ success: true, appointments })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API for appointment cancellation
const appointmentCancel = async (req, res) => {
    try {
        const { appointmentId } = req.params;  // Get appointmentId from URL params
        const { cancellationReason } = req.body; // Get cancellation reason from request body
        
        const appointmentData = await appointmentModel.findById(appointmentId);
        if (!appointmentData) {
            return res.json({ success: false, message: 'Appointment not found' });
        }

        // Update appointment status to cancelled with reason
        await appointmentModel.findByIdAndUpdate(appointmentId, { 
            cancelled: true,
            cancellationReason: cancellationReason || 'Cancelled by admin',
            cancelledBy: 'admin'
        });

        // Release the doctor's slot
        const { docId, slotDate, slotTime } = appointmentData;
        const doctorData = await doctorModel.findById(docId);
        
        if (doctorData && doctorData.slots_booked && doctorData.slots_booked[slotDate]) {
            let slots_booked = doctorData.slots_booked;
            slots_booked[slotDate] = slots_booked[slotDate].filter(time => time !== slotTime);
            await doctorModel.findByIdAndUpdate(docId, { slots_booked });
        }

        res.json({ success: true, message: 'Appointment Cancelled Successfully' });
    } catch (error) {
        console.log(error);
        res.json({ success: false, message: error.message });
    }
}

// API for adding Doctor
const addDoctor = async (req, res) => {

    try {

        const { name, name_extension, email, password, speciality, degree, experience, about, fees, address, doc_lic_ID } = req.body
        const imageFile = req.file

        // checking for all data to add doctor
        if (!name || !email || !password || !speciality || !degree || !experience || !about || !fees || !address || !doc_lic_ID) {
            return res.json({ success: false, message: "Missing Details" })
        }

        // validating email format
        if (!validator.isEmail(email)) {
            return res.json({ success: false, message: "Please enter a valid email" })
        }

        // validating strong password
        if (password.length < 8) {
            return res.json({ success: false, message: "Please enter a strong password" })
        }

        // hashing user password
        const salt = await bcrypt.genSalt(10); // the more no. round the more time it will take
        const hashedPassword = await bcrypt.hash(password, salt)

        // upload image to cloudinary
        const imageUpload = await cloudinary.uploader.upload(imageFile.path, { resource_type: "image" })
        const imageUrl = imageUpload.secure_url

        const doctorData = {
            name,
            name_extension: name_extension || '',
            email,
            image: imageUrl,
            password: hashedPassword,
            speciality,
            degree,
            experience,
            about,
            fees,
            address: JSON.parse(address),
            date: Date.now(),
            doc_lic_ID
        }

        const newDoctor = new doctorModel(doctorData)
        await newDoctor.save()
        res.json({ success: true, message: 'Doctor Added' })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API to get all doctors list for admin panel
const allDoctors = async (req, res) => {
    try {

        const doctors = await doctorModel.find({}).select('-password')
        res.json({ success: true, doctors })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API to get dashboard data for admin panel
const adminDashboard = async (req, res) => {
    try {

        const doctors = await doctorModel.find({})
        const users = await userModel.find({})
        const appointments = await appointmentModel.find({})

        const dashData = {
            doctors: doctors.length,
            appointments: appointments.length,
            patients: users.length,
            latestAppointments: appointments.reverse()
        }

        res.json({ success: true, dashData })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// Get all pending registrations
const getPendingRegistrations = async (req, res) => {
    try {
        const pendingUsers = await userModel.find({ approval_status: 'pending' })
            .select('-password')
            .sort({ createdAt: -1 });

        res.status(200).json({
            success: true,
            pendingUsers
        });
    } catch (error) {
        console.error('Error fetching pending registrations:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to fetch pending registrations'
        });
    }
};

// Update user approval status
const updateApprovalStatus = async (req, res) => {
    try {
        const { userId } = req.params;
        const { status } = req.body;

        if (!['approved', 'declined', 'blocked'].includes(status)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid approval status'
            });
        }

        const user = await userModel.findByIdAndUpdate(
            userId,
            { approval_status: status },
            { new: true }
        );

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Send email notification only for approved/declined status
        if (status !== 'blocked') {
            await sendRegistrationEmail(user.email, status);
        }

        res.status(200).json({
            success: true,
            message: `User ${status === 'blocked' ? 'blocked' : `registration ${status}`} successfully`,
            user
        });
    } catch (error) {
        console.error('Error updating approval status:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to update approval status'
        });
    }
};

// API for appointment approval
const approveAppointment = async (req, res) => {
    try {
        const { appointmentId } = req.params;
        
        const appointment = await appointmentModel.findByIdAndUpdate(
            appointmentId,
            { status: 'approved' },
            { new: true }
        );

        if (!appointment) {
            return res.status(404).json({
                success: false,
                message: 'Appointment not found'
            });
        }

        res.status(200).json({
            success: true,
            message: 'Appointment approved successfully',
            appointment
        });
    } catch (error) {
        console.error('Error approving appointment:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to approve appointment'
        });
    }
};

// API to get all users list
const getAllUsers = async (req, res) => {
    try {
        const users = await userModel.find({})
            .select('-password')
            .sort({ createdAt: -1 });

        res.status(200).json({
            success: true,
            users
        });
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to fetch users'
        });
    }
};

// API to get doctor by ID
const getDoctorById = async (req, res) => {
    try {
        const { id } = req.params;
        
        const doctor = await doctorModel.findById(id).select('-password');
        
        if (!doctor) {
            return res.json({ success: false, message: 'Doctor not found' });
        }
        
        res.json({ success: true, doctor });
    } catch (error) {
        console.log(error);
        res.json({ success: false, message: error.message });
    }
};

// API to update doctor
const updateDoctor = async (req, res) => {
    try {
        const { id } = req.params;
        const { 
            name, 
            name_extension, 
            email, 
            speciality, 
            degree, 
            experience, 
            about, 
            fees, 
            address, 
            doc_lic_ID,
            password 
        } = req.body;
        
        // Find the doctor
        const doctor = await doctorModel.findById(id);
        
        if (!doctor) {
            return res.json({ success: false, message: 'Doctor not found' });
        }
        
        // Update doctor data
        const updateData = {
            name: name || doctor.name,
            name_extension: name_extension !== undefined ? name_extension : doctor.name_extension,
            email: email || doctor.email,
            speciality: speciality || doctor.speciality,
            degree: degree || doctor.degree,
            experience: experience || doctor.experience,
            about: about || doctor.about,
            fees: fees ? Number(fees) : doctor.fees,
            address: address ? JSON.parse(address) : doctor.address,
            doc_lic_ID: doc_lic_ID || doctor.doc_lic_ID
        };
        
        // Handle password update if provided
        if (password && password.length >= 8) {
            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(password, salt);
            updateData.password = hashedPassword;
        }
        
        // Handle image update if provided
        if (req.file) {
            const imageUpload = await cloudinary.uploader.upload(req.file.path, { resource_type: "image" });
            updateData.image = imageUpload.secure_url;
        }
        
        // Update the doctor
        await doctorModel.findByIdAndUpdate(id, updateData);
        
        res.json({ success: true, message: 'Doctor updated successfully' });
    } catch (error) {
        console.log(error);
        res.json({ success: false, message: error.message });
    }
};

// API to delete doctor
const deleteDoctor = async (req, res) => {
    try {
        const { id } = req.params;
        
        // Check if doctor exists
        const doctor = await doctorModel.findById(id);
        
        if (!doctor) {
            return res.json({ success: false, message: 'Doctor not found' });
        }
        
        // Delete the doctor
        await doctorModel.findByIdAndDelete(id);
        
        res.json({ success: true, message: 'Doctor deleted successfully' });
    } catch (error) {
        console.log(error);
        res.json({ success: false, message: error.message });
    }
};

// API to change doctor availability
const changeAvailability = async (req, res) => {
    try {
        const { docId } = req.body;
        
        // Find the doctor
        const doctor = await doctorModel.findById(docId);
        
        if (!doctor) {
            return res.json({ success: false, message: 'Doctor not found' });
        }
        
        // Toggle availability
        doctor.available = !doctor.available;
        await doctor.save();
        
        res.json({ 
            success: true, 
            message: `Doctor is now ${doctor.available ? 'available' : 'unavailable'}`
        });
    } catch (error) {
        console.log(error);
        res.json({ success: false, message: error.message });
    }
};

// API to delete user
const deleteUser = async (req, res) => {
    try {
        const { userId } = req.params;
        
        // Find and delete the user
        const deletedUser = await userModel.findByIdAndDelete(userId);
        
        if (!deletedUser) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // You might want to also delete any associated data like appointments, etc.
        // For example: await appointmentModel.deleteMany({ userId: userId });
        
        res.status(200).json({
            success: true,
            message: 'User deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting user:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to delete user'
        });
    }
};

// API to get appointment statistics for all users
const getUsersAppointmentStats = async (req, res) => {
    try {
        // Get all appointments
        const appointments = await appointmentModel.find({});
        
        // Create a map to store user stats
        const userStats = {};
        
        // Calculate stats for each appointment
        appointments.forEach(appointment => {
            const userId = appointment.userId?.toString();
            if (!userId) return;
            
            // Initialize user stats if not already done
            if (!userStats[userId]) {
                userStats[userId] = {
                    total: 0,
                    approved: 0,
                    pending: 0,
                    cancelled: 0
                };
            }
            
            // Increment total appointments
            userStats[userId].total += 1;
            
            // Check status and increment corresponding counter
            if (appointment.cancelled) {
                userStats[userId].cancelled += 1;
            } else if (appointment.isCompleted) {
                userStats[userId].approved += 1;
            } else {
                userStats[userId].pending += 1;
            }
        });
        
        res.status(200).json({
            success: true,
            userStats
        });
    } catch (error) {
        console.error('Error getting user appointment stats:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Failed to get user appointment statistics'
        });
    }
};

export { 
    loginAdmin,
    appointmentsAdmin,
    appointmentCancel,
    allDoctors,
    adminDashboard,
    getPendingRegistrations,
    updateApprovalStatus,
    approveAppointment,
    addDoctor,
    updateDoctor,
    deleteDoctor,
    getDoctorById,
    getAllUsers,
    changeAvailability,
    deleteUser,
    getUsersAppointmentStats
}