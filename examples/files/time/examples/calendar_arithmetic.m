% Build a schedule from a month-end date using calendar durations.
scheduleStart = datetime(2024, 1, 31);
monthlySchedule = scheduleStart + calmonths(0:5);
scheduleDates = yyyymmdd(monthlySchedule);
weekendFlags = isweekend(monthlySchedule);
nextMonthStarts = dateshift(monthlySchedule, 'start', 'month', 'next');

disp('Monthly schedule:');
disp(scheduleDates);
disp('Falls on a weekend:');
disp(weekendFlags);
