import appointmentModel from "../models/appointmentModel.js";
import doctorModel from "../models/doctorModel.js";

/**
 * Utility function to automatically cancel appointments with past dates
 * This function will check all appointments and mark those with past dates as cancelled
 */
export const cancelPastAppointments = async () => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0); // Set to beginning of the day
        
        // Get all non-cancelled appointments
        const appointments = await appointmentModel.find({ 
            cancelled: false,
            isCompleted: false
        });
        
        let cancelledCount = 0;
        
        for (const appointment of appointments) {
            // Parse the slot date (format: day_month_year)
            const [day, month, year] = appointment.slotDate.split('_').map(num => parseInt(num));
            const appointmentDate = new Date(year, month - 1, day);
            appointmentDate.setHours(0, 0, 0, 0); // Set to beginning of the day
            
            // If appointment date is in the past, mark it as cancelled
            if (appointmentDate < today) {
                await appointmentModel.findByIdAndUpdate(
                    appointment._id, 
                    { cancelled: true }
                );
                
                // Release the doctor's slot
                const { docId, slotDate, slotTime } = appointment;
                const doctorData = await doctorModel.findById(docId);
                
                if (doctorData && doctorData.slots_booked && doctorData.slots_booked[slotDate]) {
                    let slots_booked = doctorData.slots_booked;
                    slots_booked[slotDate] = slots_booked[slotDate].filter(time => time !== slotTime);
                    await doctorModel.findByIdAndUpdate(docId, { slots_booked });
                }
                
                cancelledCount++;
            }
        }
        
        console.log(`Auto-cancelled ${cancelledCount} past appointments`);
        return cancelledCount;
    } catch (error) {
        console.error("Error in cancelPastAppointments:", error);
        throw error;
    }
};
