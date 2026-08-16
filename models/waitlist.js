const mongoose = require("mongoose");

const waitlistSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true
    },

    verified: {
      type: Boolean,
      default: false
    },

    verificationToken: {
      type: String,
      default: null
    },

    verificationTokenExpires: {
      type: Date,
      default: null
    },

    verifiedAt: {
      type: Date,
      default: null
    },

    lastVerificationSentAt: {
      type: Date,
      default: null
    },

    joinedAt: {
      type: Date,
      default: Date.now
    }
  },

  {
    timestamps: true
  }
);

module.exports =
  mongoose.model(
    "Waitlist",
    waitlistSchema
  );