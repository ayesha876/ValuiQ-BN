/**
 * vote.model.js — one attendee's stake on one post.
 *
 * "Upvote" is the verb the UI uses, but this is not a vote in the counting sense: there is no
 * vote COUNT anywhere in this product. Backing a post means putting tokens behind it, and a
 * post's rank is the SUM of those tokens (QinMvpDocs: "ranked by token support").
 *
 * STAKING IS CUMULATIVE. The same person may back the same post repeatedly, and their stake
 * adds up — which is why this is one row per person per post carrying a running `tokens`
 * total, rather than one row per act of voting. "You spent 400 on this post" is this number.
 */
const mongoose = require('mongoose');

const voteSchema = new mongoose.Schema(
  {
    post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true, index: true },
    voter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    // Denormalised so "my stake on each post" can be answered without joining Post.
    event: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true, index: true },

    // This voter's RUNNING TOTAL on this post, not the size of one stake.
    tokens: { type: Number, required: true, min: 0, default: 0 },
  },
  { timestamps: true },
);

// One row per voter per post — the unique index is what makes the accumulate-or-create upsert
// safe when someone taps twice at the same instant.
voteSchema.index({ post: 1, voter: 1 }, { unique: true });

// Serves "my stakes across this event", which the feed needs to render "You spent N on this".
voteSchema.index({ event: 1, voter: 1 });

voteSchema.set('toJSON', {
  transform(_doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

const Vote = mongoose.model('Vote', voteSchema);

module.exports = Vote;
