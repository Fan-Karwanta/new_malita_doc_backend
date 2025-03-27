import userModel from "../models/userModel.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import validator from "validator";
import { v2 as cloudinary } from "cloudinary";
import appointmentModel from "../models/appointmentModel.js";
import Razorpay from "razorpay";
import crypto from "crypto";
import Stripe from "stripe";
import doctorModel from "../models/doctorModel.js";
import { sendAdminNewRegistrationAlert, sendDoctorAppointmentNotification } from "../utils/emailService.js";

// Gateway Initialize
const stripeInstance = new Stripe(process.env.STRIPE_SECRET_KEY)
const razorpayInstance = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
})

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_SECRET_KEY
});

// API to register user
const registerUser = async (req, res) => {
    try {
        const { firstName, lastName, middleName, email, password, dob } = req.body;
        const validIdFile = req.file;

        // checking for all data to register user
        if (!firstName || !lastName || !email || !password || !validIdFile || !dob) {
            return res.status(400).json({ 
                success: false, 
                message: 'Missing Details. Please provide all required information including a valid ID and date of birth.' 
            });
        }

        // validating email format
        if (!validator.isEmail(email)) {
            return res.status(400).json({ 
                success: false, 
                message: "Please enter a valid email" 
            });
        }

        // validating strong password
        if (password.length < 8) {
            return res.status(400).json({ 
                success: false, 
                message: "Please enter a strong password (minimum 8 characters)" 
            });
        }

        // Check if user already exists
        const existingUser = await userModel.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ 
                success: false, 
                message: "Email already registered" 
            });
        }

        try {
            // Upload ID to cloudinary
            const validIdUpload = await cloudinary.uploader.upload(validIdFile.path, { 
                resource_type: "image",
                folder: "user_ids"
            });

            // hashing user password
            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(password, salt);

            const userData = {
                firstName,
                lastName,
                middleName,
                email,
                password: hashedPassword,
                validId: validIdUpload.secure_url,
                dob,
                approval_status: 'pending'
            };

            const newUser = new userModel(userData);
            await newUser.save();
            
            // Send email notification to admin about the new registration
            try {
                await sendAdminNewRegistrationAlert({
                    firstName,
                    lastName,
                    middleName: middleName || ''
                });
                console.log('Admin notification email sent successfully');
            } catch (emailError) {
                // Just log the error and continue, don't fail the registration
                console.error('Failed to send admin notification email:', emailError);
            }
            
            res.status(200).json({ 
                success: true, 
                message: 'Registration successful! Please wait for admin approval.' 
            });

        } catch (uploadError) {
            console.error('File upload error:', uploadError);
            return res.status(500).json({ 
                success: false, 
                message: 'Error uploading ID image. Please try again.' 
            });
        }

    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Registration failed. Please try again.' 
        });
    }
};

// API for user login
const loginUser = async (req, res) => {
    try {
        const { email, password } = req.body;

        // Find user by email
        const user = await userModel.findOne({ email });
        if (!user) {
            return res.status(400).json({
                success: false,
                message: "User not found"
            });
        }

        // Check approval status
        if (user.approval_status === 'pending') {
            return res.status(403).json({
                success: false,
                message: "Your registration is pending approval"
            });
        }

        if (user.approval_status === 'declined') {
            return res.status(403).json({
                success: false,
                message: "Your registration has been declined"
            });
        }

        if (user.approval_status === 'blocked') {
            return res.status(403).json({
                success: false,
                message: "Your account has been blocked. Please contact support for assistance."
            });
        }

        // Compare password
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(400).json({
                success: false,
                message: "Invalid password"
            });
        }

        // Generate token
        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
        res.json({ success: true, token });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// API to get user profile data
const getProfile = async (req, res) => {

    try {
        const { userId } = req.body
        const userData = await userModel.findById(userId).select('-password')

        res.json({ success: true, userData })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API to update user profile
const updateProfile = async (req, res) => {

    try {

        const { userId, firstName, lastName, phone, address, dob, gender } = req.body
        const imageFile = req.file

        if (!firstName || !lastName || !phone || !dob || !gender) {
            return res.json({ success: false, message: "Data Missing" })
        }

        await userModel.findByIdAndUpdate(userId, { firstName, lastName, phone, address: JSON.parse(address), dob, gender })

        if (imageFile) {

            // upload image to cloudinary
            const imageUpload = await cloudinary.uploader.upload(imageFile.path, { resource_type: "image" })
            const imageURL = imageUpload.secure_url

            await userModel.findByIdAndUpdate(userId, { image: imageURL })
        }

        res.json({ success: true, message: 'Profile Updated' })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API to book appointment 
const bookAppointment = async (req, res) => {
    try {
        const { userId, docId, slotDate, slotTime } = req.body
        
        // Parse the slot date (format: day_month_year)
        const [day, month, year] = slotDate.split('_').map(num => parseInt(num))
        const appointmentDate = new Date(year, month - 1, day)
        
        // Calculate booking window
        const today = new Date()
        const minDate = new Date(today)
        minDate.setDate(today.getDate() + 5)
        
        const maxDate = new Date(today)
        maxDate.setMonth(today.getMonth() + 1)
        
        // Validate booking window
        if (appointmentDate < minDate) {
            return res.json({ 
                success: false, 
                message: 'Appointments must be booked at least 5 days in advance' 
            })
        }
        
        if (appointmentDate > maxDate) {
            return res.json({ 
                success: false, 
                message: 'Appointments cannot be booked more than 1 month in advance' 
            })
        }

        const docData = await doctorModel.findById(docId).select("-password")

        if (!docData.available) {
            return res.json({ success: false, message: 'Doctor Not Available' })
        }

        let slots_booked = docData.slots_booked

        // checking for slot availablity 
        if (slots_booked[slotDate]) {
            if (slots_booked[slotDate].includes(slotTime)) {
                return res.json({ success: false, message: 'Slot Not Available' })
            }
            else {
                slots_booked[slotDate].push(slotTime)
            }
        } else {
            slots_booked[slotDate] = []
            slots_booked[slotDate].push(slotTime)
        }

        const userData = await userModel.findById(userId).select("-password")

        delete docData.slots_booked

        const appointmentData = {
            userId,
            docId,
            userData,
            docData,
            amount: docData.fees,
            slotTime,
            slotDate,
            date: Date.now()
        }

        const newAppointment = new appointmentModel(appointmentData)
        await newAppointment.save()

        // save new slots data in docData
        await doctorModel.findByIdAndUpdate(docId, { slots_booked })

        // Send email notification to the doctor about the new appointment
        try {
            await sendDoctorAppointmentNotification(docData.email, appointmentData);
            console.log('Doctor notification email sent successfully');
        } catch (emailError) {
            // Just log the error and continue, don't fail the appointment booking
            console.error('Failed to send doctor notification email:', emailError);
        }

        res.json({ success: true, message: 'Appointment Booked' })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API to cancel appointment
const cancelAppointment = async (req, res) => {
    try {

        const { userId, appointmentId, cancellationReason } = req.body
        const appointmentData = await appointmentModel.findById(appointmentId)

        // verify appointment user 
        if (appointmentData.userId !== userId) {
            return res.json({ success: false, message: 'Unauthorized action' })
        }

        await appointmentModel.findByIdAndUpdate(appointmentId, { 
            cancelled: true,
            cancellationReason: cancellationReason || 'Cancelled by patient',
            cancelledBy: 'user'
        })

        // releasing doctor slot 
        const { docId, slotDate, slotTime } = appointmentData

        const doctorData = await doctorModel.findById(docId)

        let slots_booked = doctorData.slots_booked

        slots_booked[slotDate] = slots_booked[slotDate].filter(e => e !== slotTime)

        await doctorModel.findByIdAndUpdate(docId, { slots_booked })

        res.json({ success: true, message: 'Appointment Cancelled' })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API to get user appointments for frontend my-appointments page
const listAppointment = async (req, res) => {
    try {

        const { userId } = req.body
        const appointments = await appointmentModel.find({ userId })

        res.json({ success: true, appointments })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API to make payment of appointment using razorpay
const paymentRazorpay = async (req, res) => {
    try {

        const { appointmentId } = req.body
        const appointmentData = await appointmentModel.findById(appointmentId)

        if (!appointmentData || appointmentData.cancelled) {
            return res.json({ success: false, message: 'Appointment Cancelled or not found' })
        }

        // creating options for razorpay payment
        const options = {
            amount: appointmentData.amount * 100,
            currency: process.env.CURRENCY,
            receipt: appointmentId,
        }

        // creation of an order
        const order = await razorpayInstance.orders.create(options)

        res.json({ success: true, order })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API to verify payment of razorpay
const verifyRazorpay = async (req, res) => {
    try {
        const { razorpay_order_id } = req.body
        const orderInfo = await razorpayInstance.orders.fetch(razorpay_order_id)

        if (orderInfo.status === 'paid') {
            await appointmentModel.findByIdAndUpdate(orderInfo.receipt, { payment: true })
            res.json({ success: true, message: "Payment Successful" })
        }
        else {
            res.json({ success: false, message: 'Payment Failed' })
        }
    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API to make payment of appointment using Stripe
const paymentStripe = async (req, res) => {
    try {

        const { appointmentId } = req.body
        const { origin } = req.headers

        const appointmentData = await appointmentModel.findById(appointmentId)

        if (!appointmentData || appointmentData.cancelled) {
            return res.json({ success: false, message: 'Appointment Cancelled or not found' })
        }

        const currency = process.env.CURRENCY.toLocaleLowerCase()

        const line_items = [{
            price_data: {
                currency,
                product_data: {
                    name: "Appointment Fees"
                },
                unit_amount: appointmentData.amount * 100
            },
            quantity: 1
        }]

        const session = await stripeInstance.checkout.sessions.create({
            success_url: `${origin}/verify?success=true&appointmentId=${appointmentData._id}`,
            cancel_url: `${origin}/verify?success=false&appointmentId=${appointmentData._id}`,
            line_items: line_items,
            mode: 'payment',
        })

        res.json({ success: true, session_url: session.url });

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

const verifyStripe = async (req, res) => {
    try {

        const { appointmentId, success } = req.body

        if (success === "true") {
            await appointmentModel.findByIdAndUpdate(appointmentId, { payment: true })
            return res.json({ success: true, message: 'Payment Successful' })
        }

        res.json({ success: false, message: 'Payment Failed' })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }

}

// API to mark appointment as read
const markAppointmentRead = async (req, res) => {
    try {
        const { userId, appointmentId } = req.body
        const appointmentData = await appointmentModel.findById(appointmentId)

        // verify appointment user 
        if (appointmentData.userId !== userId) {
            return res.json({ success: false, message: 'Unauthorized action' })
        }

        await appointmentModel.findByIdAndUpdate(appointmentId, { isRead: true })
        res.json({ success: true, message: 'Appointment marked as read' })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

export {
    registerUser,
    loginUser,
    getProfile,
    updateProfile,
    bookAppointment,
    listAppointment,
    cancelAppointment,
    paymentRazorpay,
    verifyRazorpay,
    paymentStripe,
    verifyStripe,
    markAppointmentRead
}