Build me a job board web app that scrapes new-grad software engineering jobs 
from LinkedIn and displays them in a UI closely styled after LinkedIn's job 
search page. Requirements:

SCRAPER (Python):
- Use the python-jobspy library (pip install python-jobspy)
- Scrape LinkedIn only (site_name=["linkedin"])
- Search term: "software engineer new grad" (also run "software engineer 
  entry level" and merge results)
- Locations: run one search each for "California, United States", 
  "Texas, United States", "New York, United States", and 
  "Seattle, Washington, United States"
- hours_old=2 so only jobs posted in the last 2 hours are fetched
- results_wanted=50 per search
- linkedin_fetch_description=True so we get full descriptions
- Merge all results, dedupe by job_url
- Append to a data/jobs.json file: keep a rolling window of the last 7 days 
  of jobs, dedupe against existing entries by job_url, newest first
- Each job entry should include: title, company, location, date_posted, 
  scraped_at timestamp, job_url (the LinkedIn posting link), description, 
  and company logo URL if available
- Handle failures gracefully (LinkedIn sometimes rate-limits; retry once 
  with backoff, and never crash — just save whatever was fetched)

FRONTEND (static site, vanilla JS or React — your call):
- Reads data/jobs.json client-side
- Replicate the look and feel of LinkedIn's job search page: left column 
  is a scrollable list of job cards (company logo, job title in blue, 
  company name, location, "X minutes/hours ago" relative timestamp), 
  right column is a detail pane showing the selected job's full 
  description
- LinkedIn-style visual design: white cards, #0a66c2 blue accents, 
  rounded pill buttons, gray dividers, LinkedIn-ish typography — but do 
  NOT use the actual LinkedIn logo or wordmark anywhere
- Prominent "Apply on LinkedIn" pill button in the detail pane that opens 
  the job_url in a new tab
- Filter chips at the top: All / California / Texas / New York / Seattle, 
  plus a keyword search box that filters title+company
- A "last updated" indicator showing when the data was last scraped
- Mobile responsive: on small screens the list and detail become two 
  views with back navigation

AUTOMATION:
- GitHub Actions workflow that runs the scraper every 2 hours (cron), 
  commits the updated data/jobs.json, and deploys the site to GitHub 
  Pages
- README with setup instructions: how to create the repo, enable Pages, 
  and adjust locations/keywords/schedule

Test the scraper once locally before finishing so we know the LinkedIn 
scrape actually returns results, and seed data/jobs.json with that real 
data so the site isn't empty on first deploy.