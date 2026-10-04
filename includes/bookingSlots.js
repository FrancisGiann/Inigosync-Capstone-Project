// Pure booking selection helpers shared by the dashboard UI and focused
// Node tests. All dates/hours represent the facility's Manila-local schedule.
(function attachBookingSlotHelpers(window) {
    function localDateHourToIso(dateValue, hour, timeZone = 'Asia/Manila') {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateValue || ''));
        if (!match || !Number.isInteger(hour) || hour < 0 || hour > 24) {
            throw new RangeError('Expected a YYYY-MM-DD date and hour from 0 to 24.');
        }
        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        const target = Date.UTC(year, month - 1, day, hour);
        const formatter = new Intl.DateTimeFormat('en-CA', {
            timeZone,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
        });
        let instant = target;
        for (let attempt = 0; attempt < 4; attempt += 1) {
            const parts = Object.fromEntries(formatter.formatToParts(new Date(instant))
                .filter((part) => part.type !== 'literal')
                .map((part) => [part.type, Number(part.value)]));
            const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
            const correction = target - represented;
            instant += correction;
            if (correction === 0) break;
        }
        return new Date(instant).toISOString();
    }

    function nextDate(dateValue) {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateValue || ''));
        if (!match) throw new RangeError('Expected a YYYY-MM-DD date.');
        const next = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1));
        return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
    }

    function groupConsecutiveHours(hours) {
        const sorted = Array.from(new Set((hours || []).filter((hour) => Number.isInteger(hour) && hour >= 0 && hour < 24)))
            .sort((a, b) => a - b);
        const groups = [];
        sorted.forEach((hour) => {
            const current = groups[groups.length - 1];
            if (current && hour === current.endHourExclusive) {
                current.endHourExclusive = hour + 1;
                current.hours.push(hour);
            } else {
                groups.push({ startHour: hour, endHourExclusive: hour + 1, hours: [hour] });
            }
        });
        return groups;
    }

    window.InigoBookingSlots = Object.freeze({ localDateHourToIso, nextDate, groupConsecutiveHours });
})(window);
