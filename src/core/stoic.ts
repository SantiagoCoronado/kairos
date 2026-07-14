/** One short stoic teaching per day for the clear-runway state on Today —
 *  shown in the UI and read at the end of the spoken briefing. */

export interface StoicTeaching {
  text: string
  author: 'Marcus Aurelius' | 'Seneca' | 'Epictetus'
}

/** deterministic by local day-of-year: stable all day, same on every device */
export function stoicForDate(date: Date): StoicTeaching {
  const start = new Date(date.getFullYear(), 0, 0)
  const dayOfYear = Math.floor((date.getTime() - start.getTime()) / 86_400_000)
  return TEACHINGS[dayOfYear % TEACHINGS.length]
}

const TEACHINGS: StoicTeaching[] = [
  { text: 'You have power over your mind — not outside events. Realize this, and you will find strength.', author: 'Marcus Aurelius' },
  { text: 'It is not that we have a short time to live, but that we waste a lot of it.', author: 'Seneca' },
  { text: "It's not what happens to you, but how you react to it that matters.", author: 'Epictetus' },
  { text: 'The impediment to action advances action. What stands in the way becomes the way.', author: 'Marcus Aurelius' },
  { text: 'We suffer more often in imagination than in reality.', author: 'Seneca' },
  { text: 'Wealth consists not in having great possessions, but in having few wants.', author: 'Epictetus' },
  { text: 'Waste no more time arguing about what a good man should be. Be one.', author: 'Marcus Aurelius' },
  { text: 'Luck is what happens when preparation meets opportunity.', author: 'Seneca' },
  { text: 'No man is free who is not master of himself.', author: 'Epictetus' },
  { text: 'Confine yourself to the present.', author: 'Marcus Aurelius' },
  { text: 'While we wait for life, life passes.', author: 'Seneca' },
  { text: 'First say to yourself what you would be; and then do what you have to do.', author: 'Epictetus' },
  { text: 'The best revenge is to be unlike him who performed the injury.', author: 'Marcus Aurelius' },
  { text: 'He who is brave is free.', author: 'Seneca' },
  { text: 'Make the best use of what is in your power, and take the rest as it happens.', author: 'Epictetus' },
  { text: 'If it is not right, do not do it; if it is not true, do not say it.', author: 'Marcus Aurelius' },
  { text: 'Difficulties strengthen the mind, as labor does the body.', author: 'Seneca' },
  { text: 'Man is not worried by real problems so much as by his imagined anxieties about real problems.', author: 'Epictetus' },
  { text: 'Very little is needed to make a happy life; it is all within yourself, in your way of thinking.', author: 'Marcus Aurelius' },
  { text: 'Begin at once to live, and count each separate day as a separate life.', author: 'Seneca' },
  { text: 'Only the educated are free.', author: 'Epictetus' },
  { text: 'Do every act of your life as though it were the very last act of your life.', author: 'Marcus Aurelius' },
  { text: 'Every night before going to sleep, we must ask ourselves: what weakness did I overcome today? What virtue did I acquire?', author: 'Seneca' },
  { text: 'Circumstances do not make the man; they only reveal him to himself.', author: 'Epictetus' },
  { text: 'The happiness of your life depends upon the quality of your thoughts.', author: 'Marcus Aurelius' },
  { text: 'True happiness is to enjoy the present, without anxious dependence upon the future.', author: 'Seneca' },
  { text: 'Freedom is the only worthy goal in life. It is won by disregarding things that lie beyond our control.', author: 'Epictetus' },
  { text: 'When you arise in the morning, think of what a precious privilege it is to be alive — to breathe, to think, to enjoy, to love.', author: 'Marcus Aurelius' },
  { text: 'Hang on to your youthful enthusiasms — you will be able to use them better when you are older.', author: 'Seneca' },
  { text: 'He is a wise man who does not grieve for the things which he has not, but rejoices for those which he has.', author: 'Epictetus' },
  { text: 'Accept the things to which fate binds you, and love the people with whom fate brings you together.', author: 'Marcus Aurelius' },
  { text: 'Nothing, to my way of thinking, is a better proof of a well-ordered mind than a man’s ability to stop just where he is and pass some time in his own company.', author: 'Seneca' },
  { text: 'Don’t explain your philosophy. Embody it.', author: 'Epictetus' },
  { text: 'How much more grievous are the consequences of anger than the causes of it.', author: 'Marcus Aurelius' },
  { text: 'As is a tale, so is life: not how long it is, but how good it is, is what matters.', author: 'Seneca' },
  { text: 'If you want to improve, be content to be thought foolish and stupid.', author: 'Epictetus' },
  { text: 'Everything we hear is an opinion, not a fact. Everything we see is a perspective, not the truth.', author: 'Marcus Aurelius' },
  { text: 'He who fears death will never do anything worthy of a man who is alive.', author: 'Seneca' },
  { text: 'Seek not that the things which happen should happen as you wish; but wish the things which happen to be as they are, and you will have a tranquil flow of life.', author: 'Epictetus' },
  { text: 'That which is not good for the bee-hive cannot be good for the bees.', author: 'Marcus Aurelius' }
]
