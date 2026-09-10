/**
 * Seed data for the mock "Meridian Core" credit-union servicing console.
 *
 * This is a STAND-IN for a real bank back-office system. All data is fake.
 * The canonical example member is 12345 (matches the brief's example goals).
 */

export interface Account {
  number: string;
  type: 'Savings' | 'Checking' | 'Certificate' | 'Money Market';
  status: 'Open' | 'Dormant' | 'Frozen';
  balanceCents: number;
  openedOn: string;
}

export interface Member {
  id: string;
  firstName: string;
  lastName: string;
  ssnLast4: string;
  phone: string;
  email: string;
  memberSince: string;
  branch: string;
  accounts: Account[];
}

export const MEMBERS: Record<string, Member> = {
  '12345': {
    id: '12345',
    firstName: 'Dana',
    lastName: 'Whitfield',
    ssnLast4: '4417',
    phone: '(415) 555-0148',
    email: 'dana.whitfield@example.com',
    memberSince: '2013-06-02',
    branch: 'Oakland Main',
    accounts: [
      { number: 'SAV-0012345-01', type: 'Savings', status: 'Open', balanceCents: 384215, openedOn: '2013-06-02' },
      { number: 'CHK-0012345-02', type: 'Checking', status: 'Open', balanceCents: 121188, openedOn: '2014-01-19' },
      { number: 'CD-0012345-03', type: 'Certificate', status: 'Open', balanceCents: 2500000, openedOn: '2021-11-30' },
    ],
  },
  '23456': {
    id: '23456',
    firstName: 'Marcus',
    lastName: 'Portilla',
    ssnLast4: '9902',
    phone: '(510) 555-0199',
    email: 'marcus.p@example.com',
    memberSince: '2019-03-14',
    branch: 'Berkeley',
    accounts: [
      { number: 'SAV-0023456-01', type: 'Savings', status: 'Open', balanceCents: 51002, openedOn: '2019-03-14' },
    ],
  },
  '34567': {
    id: '34567',
    firstName: 'Priya',
    lastName: 'Raman',
    ssnLast4: '1200',
    phone: '(408) 555-0110',
    email: 'priya.raman@example.com',
    memberSince: '2008-09-21',
    branch: 'San Jose',
    accounts: [
      { number: 'SAV-0034567-01', type: 'Savings', status: 'Dormant', balanceCents: 900, openedOn: '2008-09-21' },
      { number: 'MM-0034567-02', type: 'Money Market', status: 'Open', balanceCents: 7788901, openedOn: '2016-04-04' },
    ],
  },
};

/** Member IDs that trigger specific business/permission outcomes. */
export const RESTRICTED_MEMBER_ID = '99999'; // permission denied
export const KNOWN_MISSING_MEMBER_ID = '00000'; // record not found (explicit)

export function findMembers(query: string): Member[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return Object.values(MEMBERS).filter(
    (m) =>
      m.id.includes(q) ||
      `${m.firstName} ${m.lastName}`.toLowerCase().includes(q) ||
      m.lastName.toLowerCase().includes(q),
  );
}

export function formatUsd(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

let subAccountCounter = 90;
export function nextSubAccountNumber(memberId: string): string {
  subAccountCounter += 1;
  return `SAV-00${memberId}-${String(subAccountCounter)}`;
}
