# WeVolunteer — Owner Request History (source record)

**Supplied by the owner:** 2026-09-30
**Used by:** [`2026-10-final-requirements-audit.md`](2026-10-final-requirements-audit.md)

This is the owner's own account of everything asked of WeVolunteer, in the order
it was asked. It is the material the 2026-09-21 full-system audit recorded as
missing (§57 / P0-2: "the referenced historical product material was not
supplied"). It is reproduced **verbatim**, spelling included, because its value
is that it is the owner's words and not a paraphrase of them. The requirements
ledger cites it by ID; where the ledger condenses a request, this file is the
authority.

The owner prefaced it with two instructions that govern how it is read:

- The original roadmap is **not a strict blueprint**. Hosting moved off Vercel
  and other services changed; the app is judged against intent, not against the
  service list at the end.
- The work is to be divided into phases, because it is long and detailed.

---

````text
Final Audit Prompt



Hi, I think we finished all the features we want. But right now I want to test if the app actually has everything I want it to have.

I'll paste everything I added to WeVolunteer, and you should check everything I did. It’ll be in order of how I did it too [Like for the subsections] so it’ll be good if you can check features added if they’re added or not. If issues that were fixed aren't actually fixed. Did I miss anything by chance? And finally, and most importantly, if the app is how I imagined it to be.

This was the original roadmap. After this roadmap, everything I ACTUALLY added to the app might not fit it, but I'm still sharing it with you so you can get a general understanding. REMEMBER IT'S NOT THE PERFECT ROADMAP. TOWARDS THE END I CHANGED THE HOSTING PLATFORM TO NOT USE VERCEL AND OTHER STUFF. ASK CLAUDE TO ACKNOWLEDGE THIS AND TO MAKE SURE THE APP IS PERFECT AS IT IS. THIS IS NOT A STRICT BLUEPRINT WE HAVE TO FOLLOW. Divide this into phases because this is going to be a highly detailed, lengthy process, and it'll take weeks to finish. Got it? Good Luck.


Issues fixed:

The 403 no authorization screen the resolution (screen size) is off. It looks weird and uncomfortable. I want you to check and review on mobile, laptop etc. Look at 404 and 500 etc. Those take up the full screen and look perfect. I want you to copy that but for no access got it? Make sure all the other screens also match the standard.

Admin Audit log isn’t styled properly. It works (half) but design-wise looks terrible. Might need to change the gui for that.

The admin moderation process isn’t exactly the best either. I could suspend the user but id expect the user get a splash screen when she opens her account that says her account has been suspended you can’t do anything and its just a splash screen with a like red boarder or smth blurred background app and u can’t exit that splash screen. The reason why I like that idea is because you still can log in/sign out from the account plus the reason also is given there and it doesn’t automatically sign you out from all devices just cause you got suspended.

For messages it says “New message
You can message the organizer of an event you have applied to.” But it shows the same for admins and organizers? Seems contradictory if im being honest.

Menu bar for admin is too big. It is really filled and it looks uncomfortable. It would look even worse on mobile because you need to compress that. I suggest a single Admin bar and SuperAdmin Bar that has buttons or idk it’s your choice for the design but it would be like you can access the webpages through that one place. Not so many.

New Event should also be a button in oppertunities for organizers. ITS THE MOST COMMON BUTTON THEY USE IT SHOULD BE RIGHT SIDE SAYS “CREATE EVENT” or smth and take it to the new event page. Clean up that logic please.
Should be like that for everyone who can use it. So like removing the “New Event” from the menu bar

For the Owner Accounts I like how the moderation center holds the links for all those things. Remove them from the menu bar. Make it so that the moderation center is the only way you can access those webpages.


Things it should remove and be on the Moderation Center page:
[IMPORTANT: DO NOT UNDER ANY CIRCUMSTANCES DELETE THEM I JUST WANT THEM TO BE REMOVED FROM THE MENU BAR SO THAT ITS ONLY ACCESABLE FROM THE MODERATION HUB]
Community Impact
Appeals
Admin Roster
Audit Explorer
Errors
Platform Impact

My “Mahit” account is kinda like a hack account it should have a secret switch mode for it so I can choose between looking like an owner, a admin, an organizer, and a student. maybe that would be fun. Perks of making the app.

I want my owner’s Mahit account username to be @…. If another account exists with that username delete it. The only two accounts I care right now are [wevolunteer.platform@gmail.com](mailto:wevolunteer.platform@gmail.com) and [Mahitp.16@gmail.com](mailto:Mahitp.16@gmail.com) anything else not that important and safe to delete (maybe except the demo accounts)

My Profile should be there for the WeVolunteer Account but make it a special profile cuz it’s the owner… put its own stats or like put something cool to differentiate it from students organizers and admins.

The Your Next Shift button colors are too bright for dark mode. Change it a bit to make it contrast and make it look realy neat and clean even in dark mode. Try to make it similar to the other greens ur using in the page to make it symmetrical.

I don’t like how moderation center is still kinda detached from the menu bar for admins [Im talking about the seperator]. In mobile the menu bar is shown when u click on the three dots which isn’t good because thats like the main thing for the admins so it doesn’t make sense to keep it in the three dots. Either shrink all icons to fit it and give the moderation center a smaller name [but make the name same for all platforms and for everyone kinda like a revamp] or make it so that the menu bar is scrollable horizontally on mobile for them to access it but make it so that scrolling reveals the three dots so its 

Dashboard
Opportunities
Calendar
Messages
Admin

Then scroll for three dots and in three dots:
Notifications
My profile

Also for owner/partner users the select preview ui isn’t that clean the drop down box and everything looks ugly fix it a bit.

Uhh hows the admin going to verify the external hours. I told you that the system is like the user can input the external hours and itll show up in another transcript but wouldnt show up as verified hours. No verification nothing. Make sure that external hours is only for tracking and it is not verified in the app. Make it a seperate “log” webpage for the user to see all their volunteering hours. Don’t add it to the menu bar you’re just going to make it more clutter ed.

NEW RULE. TRY NOT TO ADD ICONS TO THE MENU BAR IT MAKES IT MORE CLUTTERED. TRY TO ALWAYS FIND A WAY TO WORK AROUND IT BY ADDING BUTTONS TO EXISTING ICONS AND LIKE MAKING IT SO THAT YOU CAN CLICK BUTTONS IN EXISITING PLACES LIKE DASHBOARD TO GO TO “LOGGED HOURS” and a back button to go back to dashboard. You get what I Mean?

I want the merge of Opportunities and Find to be clean… make sure the UI still looks good and it looks well placed and well thought out instead of clumsy got it?

Instead of click username then:
Edit Profile
Notifications
Settings 
Sign Out

Make it
Profile
Notifications
Settings
Sign Out

And on mobile make it so that the Profile is in the three dots instead of a seperate tab.
Mobile UI looks really weird because on dashboard [Only on dashboard for some reason] you can zoom out and it looks really weird fix it so u can’t zoom out of that or maybe its my device don’t fix anything if there’s no problem got it? But I want you to investigate this and find what’s wrong and fix it if it really is wrong.

It looks weird that find people is its own seperate tab. I want you to make it inside Oppertunities… like the search bar should live on top of the Oppertunities Page where you can search for people, organizations, volunteering oppertunities etc. It makes it use less tabs in the menu bar and looks way cleaner. Also now that profile is an option make edit profile not an option delete it from the menu bar or the three dots and add a button in the profile tab to edit profile. You don’t need a page to view the profile and another to edit it right? But keep same layouts for both pages tho I like it. If you want make the Profile tab in the bottom left corner when u click on ur profile

Make it so that all instances of using the WV logo it should use the WV logo from the dark mode. Thats right now all the logos for white mode which show WV I want you to change it so that it uses the WV logo colors in dark mode. Also make sure u change the logo in the tab heading too. Because a logo should be the same for light mode and dark mode. We Can’t have two different logos. Make sure the email logos also change to reflect it.

Make sure on desktop too you remove Profile from Menu Bar. It should live in the Click Profile and you should see
Profile
Notifications
Settings
Sign Out

Make the “Partners” or Owners have a custom profile webpage because we’re the owners and we can… make it cool make it stand out. Maybe make @Mahit’s account still show student information since he’s a high school student and he could still show his hours and stuff to colleges so both of them get different profile pages but still should be different than other students should send a message and be custom.

Tiny hack. When you search with @ I should only see Usernames. When I search with # I should only see opportunities with that tag or even organizations with that tag.

Add it so that volunteer’s number of events signed up and number attended shows up when ur in applicants tab and some applies. A quick glance to see if they’ve been attending the events they’ve signed up for.

Should we change the Oppertunities tab to say something else? Since it’s not just Oppertunities, you can find people and organizations there too. But like the name shouldn’t be longer than Oppertunities because it needs to fit on the menu bar for phones and desktops.

About Us is repeated twice in the Help section in Settings remove the first one [The One kinda with the legal center] and keep the separated one. Make it so that the About us should also have an icon like the legal center but don’t make it a heart icon make it some other icon instead.

When I try to create an organization the tags don’t work I can’t add tags because when I add it itll say tag should be 40 characters or else even tho I entered all the tags. So when I don’t have any tags it doesnt check that and its fine. So tags isn’t working at all.

Check if Check In and Finalize Hours Works for the Organizer? Is it like only after the event is over can u finalize the hours? How is it set up [If it works at all]

I feel like we should allow members to talk with their friends. Its still not allowed. If it is allowed make sure the text box when you click new messages says messages organizers AND friends. You have to update it so it makes sense because now its not just organizers.

/events should be /discover make sure that naming discrepancies doesn’t exist in the code base and everything is currently up to date.

Service Records on the Dashboard… Its too long. Like it makes the dashboard look weird showing all the service record. Make a cap on how many you can show and then just make a “show more button at the end to take them to the specific webpage”.

In Profile its kinda the same thing except for “Service Record” again show a limited number of them then click show more to take them to the total.

“Reliable Volunteer: Turned up for at least 90% of the shifts you signed up for.8/11/2026”
The Reliable Volunteer achievement should be a badge actually I THINK THATS A GOOD IDEA. MAKE THE RELIABLE VOLUNTEER A STAR OR A MEDAL BESIDE THE VOLUNTEER FOR ORGANIZERS WHEN THEY SEE APPLICANTS FOR AN EVENT. WHEN AN ORGANIZER HOVERS OVER IT ITLL SHOW “SHOWED UP TO OVER 90% OF THE SHIFTS THEY SIGNED UP FOR”

But it would be too punishing for students at first so we would need to take care of:

Overall attendance: keeps the full history.
Recent attendance: only considers the last 10–20 events.
Reliability score: older no-shows gradually matter less.
Recovery system: attending events consistently increases the score faster.

Plus

Imagine two volunteers:
Volunteer A

* Signed up for 1,000 events
* Missed 100
* Attended 900
* 90% attendance

Volunteer B

* Signed up for 10 events
* Attended all 10
* 100% attendance

The percentage makes B look better, even though A has actually shown up 900 times.

Make a badge for first time volunteers too and a badge for hasn’t volunteered for a while. This is the system I was planning to introduce! A way to let organizers know about a volunteer without it sticking in the way or being unfair. A volunteer loses the “Reliable Volunteer badge” when they’ve gone below the 90% threshold and they have to go back to It in order to keep it.

Those are badges not achievements so shouldn’t show up in achievements [That means no more Reliable Volunteers achievement]

Badges would be like 5 10 25 50 75 100 150 200 250… etc [Just make like hour stuff like that but then obviously the highest badge should show first and it should rank in desending order. 250 200 150… there should be a show more button to show the hours else ull reach the same problem as the service hours where it doesnt look good and it shouldn’t expand on the same page because then itll still look ugly. The plan is to make sure it doesnt look ugly no matter what u do.

Early Supporter badge is good I like that. There should also be a streak badge like the hour badges. That should also be decending order.

It should be highest hour, highest streak, second highest hour, second highest streak. Etc.

I want you to think of other cool achievements to add without pilling them on for the sake of it. Don’t add lots of achievements to look cool if u think the multiple hour and streak thing is bad I give you permission to change it but I want you to think of good achievements to add.

Transcript doesnt print properly - Light mode or dark mode. It prints weirdly. Same with certificates.

Transcripts look kinda weird compared to certificates. Like I really like how certificates look its nice and its cool. Transcript is like kinda bland which I mean if its a transcript to colleges or jobs then ok yea I kinda get it unless u want to change that.
Transcript shouldn’t mention every shift u’ve taken tho. It should mention every event but not shift. Make it take total hours done at event.

When your looking at the shifts right now. Its kinda conjested there’s the “Your confirmed text” then Add to Calendar button and then the check in with QR code Button. Its all taking too much space and looks cluttered. Find a solution for this. One suggestion I can give is maybe using icons instead? Like a calendar icon and a QR code Icon? But use ur suggestion first here. Whatever u think would work. If you don’t find anything better then u can just use my solution.

The Map created when the event is being made (viewable to organizer) is kinda weird. Change the theme of the map. Make it look regular the contrast theme looks terrible.

For confirmed shifts:

Confirmed shifts
3
AUG
14
Event
Help · 9:00 AM – 11:00 AM · 2 hrs
ConfirmedViewCan't make it
AUG
15
Event
Help · 9:00 AM – 11:00 AM · 2 hrs
ConfirmedViewCan't make it
AUG
18
Softball Tournament Snack Shack
Volunteer (any age) · 3:30 AM – 5:30 AM · 2 hrs
ConfirmedViewCan't make it


It looks weird that it says Confirmed View Can’t Make It Remove Confirmed from there because it looks like Confirmed is a button even tho it isn’t. Itll give volunteers the impression that they need to confirm their shift even tho they already did so just remove confirmed from there.

Its also annoying that every single time the user enters the browser they have to click allow location banner on top. Its a one time thing. They should allow permission once and then every time u load u check if they have the location on. If on don’t show banner if off then show that banner. If they dismiss it dont show the banner until next session got it?

Messages have a weird problem where like the most recent text is appearing on the top of the screen when it should be appearing in the bottom of the screen instead. Check messages simulate a conversation and see what works and what doesnt and fix it.

I think organizers should have permission to kick participants [only before the event starts] in case they don’t want that participant attending or they change their mind. CANNOT KICK ONCE EVENT STARTED AND CANNOT REVOKE HOURS.

Same for Organizations too. Org Managers should be allowed to kick/remove members from the organization if they want to.

Make it so that when you change a document in the legal center it’ll show up in a pop up notification for the users next time they open the app that ____ has been changed and show a part of the changed lines along with a link to view the full document. Make sure that it looks good and genuinely well placed. I hope there’s a clause that says that it’s your responsibility to view the documents whenever they change. Send an email too along with the pop-up notification. Format the email well too.

Im confused difference between transcript and certificate? Just clarify that those two are different right? 

In the certificates for the Volunteer Name and Authorized Organizer I want you to print name for both of them cuz now it looks blank and it looks weird for that.
In the transcript make sure it prints it without the white background.
Im attaching both the pdfs for you to reference and I want you to fix those two issues.
I want the name to be above the black line like it would say.  

Mahit Pulavarthi                                  Organizer Name
—————————                               ———————————
 Volunteer                                           Program Coordinator

And for the transcript what are we keeping for the authorized signature? Me?  

Mahit Pulavarthi  
—————————                 
 Authorized Signature     
Founder of WeVolunteer?

I mean that would be cool ngl

For Organizations. Why can’t I add a picture for them? I think that would be useful. Also could bring the “add emoji as picture” option too like how u did for profile pictures. Make it so that I can upload pictures to be the logo/profile picture for my organization not just icons. And I don’t like how u made it like only a couple of icons are allowed. I want it to be like how in Apple iMessages you can set group chats to have specific emoji as the image and customize the background color too. Add that for user profile pictures too since u allow them to have own uploaded images and emojis too. So like how Apple Is doing it.

Organizations can have anouncement posts too. That organizers can use to give information. Users are allowed to reply to the announcements but there should be checkbox or a button allowing Organizers to change that setting.
The Allow Replies should be a checkbox in Manage Organizations. You can’t manually change if a post allows replies or not. Its either all or none. Just make the checkbox disable replies for all posts and ticking it again allows replies for all posts.

We added a lot of new features to the app. Check if mobile UI has been impacted by this at all. I mean specifically for Dashboard like is it weird uncomfortable? Do users have to scroll a lot for the events using the horizontal scroll etc. For messages is the “Message New People” button too big?

Im not sure if the welcome screen login and signup pages are properly loaded on mobile I just want you to check (For now) and see if its not then we take action If its unable to load or its a blank screen.

Messages work fine. The Certificate transcript doesnt work [It prints the whole webpage instead of just the certificate itself].

The organization doesnt show the organization picture when u search it up in the bar or in the organizations tab in discover. Also there should be an option to upload your own image to show too. Just like how we have the image as first and the emoji is the backup option.

Make @Mahit profile look like a student’s profile. Even tho he is the platform owner I want you to keep that badge but make his profile look like a students profile and give him every single achievement and badge there is that u’ve made [To see what all badges and achievements u have made]. He is the platform owner but he also is a student so its fine just give him the hours and the streaks and give him every single badge and achievement.

The log in screen on mobile... microsoft logo is a bit sticking outwards just look and make sure u adjected the whole thing to be better on mobile. Also make it so that u don't have to scroll too much on mobile. I feel like thats kinda annoying where u constantly have to scroll down to get everything in the page and theres a chance u forget something in the page because u didn't scroll. So yea uh think about this I would say this is a bigger thought we should have.

And for the authorised signature on the transcript u still didnt keep anyone. Preferably keep me [Mahit Pulavarthi] founder of WeVolunteer or smth like that. That would be really cool and nice. Unless theres a specific reason u found not too.

Also if an organizer made an organization there should be a button called manage organizations to edit ur old organizations. Maybe lets make a button called Organizations instead of Create Organization just swap out the button name and take them to a page where u can see ur organizations and a button to create a new one. Make it more cleaner and easier to just manage organizations as a whole. Make it /organizations or smth idk u can choose but keep the name same for all it should be symetrical and professional.

I like the remove button for organizations but notify the user if they were removed. Make a pop notifications that asks like “are you sure you want to remove him? He can still join back” and another smaller red button that says ban thats more permanent. Now If its just a kick there should be a text box that says reason (optional) but if they chose the ban button the reason button is mandatory now. Also notify the user when they join a session like You were kicked by Name Organization reason: Reason. You can still join back if u want to. And another message for ban if they do get banned that says you cannot join back and make an appeal? Button too got it?

Make @Mahit profile look like a student’s profile. Even tho he is the platform owner I want you to keep that badge but make his profile look like a students profile and give him every single achievement and badge there is that u’ve made [To see what all badges and achievements u have made]. He is the platform owner but he also is a student so its fine just give him the hours and the streaks and give him every single badge and achievement.

Account email is mahitp.16@gmail.com username is @mahit

My names is way too high up the Line for the Transcript. Look at how certificates had the name directly on top of the line. Just change my name to be lower onto the line got it? Don’t change the certificates at all.

In discover tab the date box is long for some reason. It says Aug 14 event and that box is stretched a bit it looks weird. Its fine for The Softball event tho when it says Aug 18 but the Aug 14 one looks weird.

How does appeals even work because someone who wasn’t involved in the ban will reply? What if there’s one organizer? I think its better if all organizers of the organization can see the appeal in like an appeal box in the organization [Admin Only]. It should be at the bottom.

Make it so that the see all for achievements button is clickable and it takes you to /profile/badges or /users/@user/badges depending on who’s badges u’re looking at.

Certificates are too long just like what we did with the service hours only show some of the certificates and make a see all button to take you to view all the certificates.

The floor should be the same for shifts and certificates so that it looks neat and the ui looks clean.

Make it so that when u view other people’s profile you can see their certificates you can’t download them or you can’t download their transcript for them. Actually make it so that you can’t view their transcript thats a better decision. Make it so that the service and certificates can be changed to be private or public depending on their settings which is an already implemented system so u just got to make it so that service hours and certificates may or may not be visible depending on the users preference.

It should be visible under /users/@user/hours or etc smth like that if public got it?

Plus make sure that when displaying tags for any event you are making sure u have a limit to how many tags will be displayed. For example for the tags below the filter box make it like the 15 most popular tags in the platform. For events make it like 4 tags because u have to click the event in order to view all the tags.

Make an appeal button beside the join button for usingif you are banned so you can appeal. Right now the only way to appeal is through the notification but the notification can be buried under 100s of notifications or just forgotten.

Make it so that if your banned the join button turns into an appeal button where you can click on it and click appeal. Make sure the button doesnt work once u submitted it and that itll say ur application is being processed. If banned again make it so that applicants can only submit 5 appeals in 30 days or some rate limit like that so that they don’t get annoyed by how many appeals a person sends. Ofc an organizer can also report a student if they’re being annoying and spamming them with appeals even tho they clearly don’t want the student.

The change to admin button for students in organizations is really misleading. I thought it was a manage student button because of the settings symbol. Make it so that thats the only button available and when u click the settings symbol u get a box with options like promote to student org [or demote if they already are make the button change text depending on role] and a kick user button and also a ban user button. I think if we make this more clearly itll be better to understand.

Tags for events? Already exist I think? Check If they do exist.

When u click the manage button on any of the members for an organization it doesnt show the list of actions you can take or the pop up screen with the actions you can take.

Wherever u have “mailto:support@wevolunteers.org” or mailto anything it doesnt work when you click on it.

The Report a Problem button doesnt work. Its also a mailto problem so uh it might work if u fix it. However I was thinking a new webpage like /reportissue or /reportproblem or idk something which sounds professional and better than those two. It should be a drop down what type of problem is it and like a serious report an issue page like include screenshots or stuff like that got it?

Issues to Check:

2FA still doesn’t work. I tried doing auth 2fa and it says Internal Server Error during 2FA. Make it so that Email 2FA is always an opinion (If 2fa is set up) because its not given the option and so it looks stupid. Recovery Codes should work if like u can’t do both like it should always be a backup that would be nice. Always as an emergency backup option. Make it so that you can save the backup codes as a txt file or a png [to save to ur camera roll]. That would be convient to have options.

Yea so be careful and make sure Internal Server Error isn’t a problem for both email or Auth. Even Recovery Keys too if thats possible.

2FA kinda works but its weird. It shows me you have 9 codes remaining after I used it once and signed in then signed out then used auth code to sign in but it showed u have 9 codes remaining… maybe don’t make it recurring every time u sign in check if it works or doesn’t.

Even if I remove Auth it still shows that which is kinda weird.

In security if I click change email to not default and try to exit it doesn’t let me exit [it glitches] make sure it doesn’t happen anywhere else for any other pop up box got it?

Make sure that when adding another auth thing [Like adding email when already using auth app or vise versa] it doesn’t restart the recovery codes. Just check that once.

AI mode should be enabled now because I still can’t enable it through npm run dev. Make it available to everyone now so that itll work and I can try it out for myself

Im still getting Internal Service Error for 2FA this is a serious problem and its been like this for a while now.

The join button is still visible to those who are banned (I think) I told u if ur banned the button color should change to red and say Appeal? Saying that ur banned from this Organization. If Appeal Application is already sent it should be gray with a clock saying that Appeal Sent. Put Icons on the other buttons too.

There’s no place to view currently banned users for organizations. I feel like there should be a place where an organizer can unban a user without having them to appeal. So basically I want the moderation system to be like a “discord server” if you get what I mean. Where the server is the organization.

SERVICE HOURS THIS YEAR
215 hrs 43 min
of 25 hr goal

Hours certificate

Goal reached — 190 hrs 43 min past the 25-hour Silver Award target.

How hours are credited
Signing up doesn't earn hours. After a shift, the organizer marks who attended, and the hours for that shift are added here automatically. Every hour on your certificate is backed by an organizer's confirmation.
UPCOMING
0
AWAITING REPLY
2
SHIFTS COMPLETED
17

This box should be Above waiting for reply not below the waiting for reply section? Keep everything else as is

ACTIVE EVENTS
1
VOLUNTEERS CONFIRMED
11
28 shift assignments
AWAITING REVIEW
2
HOURS CREDITED
236 hrs 43 min

This box should be above the review hours box. I’ll send the review hours box below but keep everything as is:

READY WHEN YOU ARE
4 finished events with hours not closed out
The hours are credited and still correctable. Closing them out makes them a permanent part of each volunteer’s record, which cannot be undone.
Review hours

JUL
12
Food Pantry Boxing & Distribution
Finished 7/12/2026
Hours open
AUG
10
Event
Finished 8/11/2026
Hours open
AUG
14
Event
Finished 8/15/2026
Hours open
AUG
18
Softball Tournament Snack Shack
Finished 8/18/2026
Hours open


Welly AI doesnt start for some reason [Im using the adv model] Check why and try to fix it. The balanced model does work however

Welly AI/Chat can’t create the event for organizers. Make sure that when creating the event you ask details such as Event Name location shifts dates stuff like that. It would also be helpful if Welly AI/Chat can check if the event can be created or if it can’t and just say why it couldn’t create it [Because app open date after first shift date] and communicate it in regular English. It should be a proper convo and it should actually make the event without making a generic event like the one listed below.

Create an event

Welly replied:
Event draft prepared:
Title: Community Service Event
Location: Community Center
Spots: 10
This hasn't been created yet. Reply "confirm" to create this event, "cancel" to discard, or set it up directly on the Create event page.
👩‍💼
You asked:
confirm

Welly replied:
I couldn't look that up just now. Please try again.
👩‍💼
You asked:
confirm

Welly replied:
I've confirmed the event details. Would you like to proceed with the event setup?
👩‍💼
You asked:
yes

Welly replied:
Got it! Ready to start the event. What would you like to do next?


Issues Now:


For emails like there’s no profile picture for the emails. It looks kinda bad and sketchy cuz there’s no pfp. Add one. Could be an icon could be an image. Could be the WV logo but add it.

Phase 2:

Use Graphify whenever it meaningfully reduces code exploration or helps verify architectural relationships. Prefer Graphify over repeatedly rereading unchanged files, but don't use it when working within a small, already-understood part of the codebase. Always remember this for this project.


WeVolunteer:

Finished:

Can download data & Delete Account
Improved Notifications
Add DMs
Calendar Integration
Possible to make “Add to HomeScreen Button”

Better Mobile Experience and OAuth
Better Error Handling (Specifically 400s and 500s)
Need to create Private Policy and ToS later (Maybe If im not too lazy)

WeVolunteer’s Account is like a master account - can create admin accounts on it. Can also look at overall stats of the app like how many active users, how many events total, how many hours, most common type of event? Using tags. It should be a master dashboard. Kind of like you know something that would be cool to post
Like we helped ___ people volunteer or ___ hours of volunteering. It should be that type of information.

My person account is kinda like a secret main account too. It can switch between a student, an organizer, an admin, and a “master account” maybe a better name for the last one. But it can switch through all of them can create events but also sign up for them. Can allow organizers to join and even admins like “WeVolunteer”. Can switch between the dashboard for all of them.

WeVolunteer ([wevolunteer.platform@gmail.com](mailto:wevolunteer.platform@gmail.com)) and My Personal Account ([mahitp.16@gmail.com](mailto:mahitp.16@gmail.com)) are the two most important accounts on the platform so just remember that.

Superadmins should also be allowed to create “admin accounts” since its just me and weVolunteer account who are superadmin
Im like imaging a textbox I plug in an email address and if that account exists its automatically promoted to admin if it doesn’t exist just store it so that if that account is ever created its a superadmin. Of course, there should be a log of all “admins” and a possibility to remove access (For being an organizer or admin) u can’t make someone a super admin; it’s only us two.

My “Mahit” account is kinda like a hack account it should have a secret switch mode for it so I can choose between looking like an owner, a admin, an organizer, and a student. maybe that would be fun. Perks of making the app.
Speaking of which is there a button to “revoke” access? Maybe a better name but like make an approved organizer unapproved ban a student or demote an admin. U can’t change superadmin thats the one only thing. Banned students shouldn’t lose all their information or records just because they’re banned. Also only admins should be able to do that maybe. Seems complicated but we can add that. 

Profile Pictures
Badges [We already have like a Silver Award or something] real badges would be cool.
2FA
Change the UI for the date picker in signup page. It kinda looks generic and ugly. Use that same date picker UI for the pick date in calendar the date picker in admin audit log basically everywhere should be around the same size possible the black-green/white-green theme depending on the user preference. It’s not a massive change just a simple UI change to make the app better.

I want to add like a system where organizers can see number of events the applicant signed up for vs the number of events they actually attended. Not percentages because it would be greatly overestimated if he only signed up for 2 events but attended one it would show up as 50% which is bad and would be a bad judgement. It should be on the user profile too.

The private mode on profile seems a bit stupid? Why make a bio on the platform if you don’t want other people to see it? At that point just dont write anything on the platform. Make all profiles public /user/username thats how you search them up. We’ll keep the private mode but tweak it a bit. Private mode should not let people see ur grade, your school, PII, except for name, location? [We’ll put it in the text box when they haven’t typed anything “Please don’t use your exact address”] and hobbies/skills. Along with that information each person should get like when account created, last active [last time volunteered], number of events signed up, number of events showed up. Stuff like that [Which should be all public btw on their profile]. I also suggest they use this (number of events showed up/number of events signed up * 100) in the auto select thing but shouldn’t have much weightage compared to number of hours volunteered. Hierarchy is Number of Hours Volunteerd then Show up Rate

Organizers can change the time that a volunteered stayed right? Like if they had to leave early or they stayed to help overtime?

If a volunteered had to leave early should have a checkbox to see if they want to subtract hours they didn’t stay.
Should organizers be able to make events without hours? Because sometimes it’s not just about the hours

Volunteers should have the button like how organizers have the create new event button it should be a log external hours button exactly like the same button. Basically duplicate the create event page too but make it so that instead of creating a new event for people it creates a new external event and adds it into the students volunteer logs as external. Warn user that it’s not going to appear in the transcript but will appear in the volunteer log. I think you should make it 

Since we’re making profiles public make it so that you can search profiles up
/users/@username that’s how’s you should be able to search people up. Should have options top right corner three dots in profile to Mute Restrict Report and Block User. Can “friend” user so that whenever they volunteer signed up u get a notification so u can sign up too [Ofc their privacy setting should be friends which we would make so that they can allow this]

Also let’s create organizations. Since we have tags and I suggested #NHS tag like let’s make a NHS organization. Only organizers can make organizations but users can search them up and join them. Maybe make a new menus bar icon to search for users and organizations. For example Organizer can make a South Brunswick High School Volunteering Club and users can join it. Every event the organizer makes they can add their special Organization tag which will alert everyone in the organization that a new event is made.

In the help section in settings ,
Instead of Terms, PP, and SP make it say “Legal Center” instead. It sounds nice.
Should add a “about us” section talking about WeVolunteers our mission/goal/ etc. Should have our motto or catchphrase WeVolunteer: because we care. I want you to be extremely detailed for this about us section be specific and detailed. Should be about the WeVolunteer as a whole. It shouldn’t be explaining technical stuff at all. Use whatever skills you need to but make it sound real and genuine. Make a better prompt for this. Obviously, right now, it’s ok but it could be better.

I should add a custom webpage [For Owner Accounts only] that allow you to change the text from the Legal Center. Cuz those are legal text it would seem inefficient if I needed to code them every time I wanted to change it. Create an amazing custom UI for changing the texts for them but also where I could choose to change the version number [It can only go up] I can change it to go back through you [The AI] or by the code. It should be clean detailed and like not in the menu bar. Probably in the settings right under legal center it should say edit legal center and then I get all the different texts like a Google Docs. Can change the version number like 1.0.1 1.1.0 or 2.0.0 stuff like that. Also the option below like save changes [green], discard changes [red] and a fill-in-the-blank that says version number. Should be like that for all. It would be helpful.

Graphs at the bottom of Dashboard can be better. Make the UI better and make it make more sense like what’s needed what’s cool what’s inspiring etc.

Add back Maps, Location, and Weather Update. I think most of the ideas already exist it’s just a matter of where to add them where its kinda making sense, it looks good, useful and a cool feature. Example is a user wants to find “locations near me” they can filter events using location. That would be cool. Imagine if below the Where the Location is actually a blue link instead [like a link link that most user interfaces use] that show its clickable and when u click on it u get the option to option it in a maps app and see how far it is etc. Include the location in the calendar event and make the calandar event have an eta alert if thats possible else u dont need to do it. I can think of like a billion ways this all would be useful it’s your job to implement all of it thoughtfully.

QR Code Logins? Organizer should scan User’s QR code. When the User is showing the QR code it should show QR code below @username and the Time Generated QR Code. QR codes are only usable for 5min so make sure that after 5min it’ll show that u have to regenerate the QR code. Make it so that QR codes are only available after the event started. Make it so that Organizer can check in with QR code only if event started too. Ofc the Organizer should have the option to check in manually too using the pre existing interface too so don’t remove that option. We’re only adding a feature we’re not changing anything else.

Specifically Track NHS hours or some sort of system to Track Hours for specific stuff like Volunteering Club or NHS or etc. Just a thought for now. Maybe it can be by like a place to look at what organizations your part of [NOT IN MENU BAR REMEMBER THE RESTRAINT NO ADDING NEW ICONS TO THE MENU BAR TRY TO ADD IT IN THE EXISTING INTERFACE TO MAKE IT CLEANER]. And when u click on the specific organization you can see how many hours you volunteered in it. That would work wouldn’t it? A Problem I think of is like what if a organizer creates a tag called Fun and people start using #Fun [like in general no relation to the organization] but it would show that in the organization or smth? Idk it should be specific organization tags. We need a system to see like different things. We decided that @ is for username # is for tags what about for organizations? Organization tags? Organization tags should they be similar to regular tags? It would cause some collisions? Idk I just want to make this app a fun and not confusing experience to the users.

Use Zayd’s Ghost Github Repo as inspiration. Download local llm smog 135M on user’s browser. Use it as the aI so no API cost etc. Maybe qwen2-0.5b
AI recommendations? (If free is possible no AI credits or things like that)
Maybe it can be like based on skills user picked or most commonly picked volunteering stuff the AI could recommend.
Already have a “oppertunities near you” I like the icon there it kind of tells you that its like suggested specifically for you so don’t change that text or that icon at all, Instead of oppertunities near you it could be suggested for you. Also could factor in distance too if that helps.
Speaking of which… there still isn’t a volunteering near me button that sorts it based on how far it is from you. I think thats a really good option.
If AI is enabled make it suggest tags for new events too. I think adding an AI integration wherever possible would be beneficial and make the work easier for all.

For Users logging in old hours [Outside WeVolunteers] Make it so that you can scan the Certificate and then using the text it can analyze it and put in the details itself. It’ll still take it to the log new hours page with the details it found prefilled but still allowing the User to fill in data not written or to change existing data written by the AI.

Yes I want the oppertunities near you to have that same banner at first it says smth like Enable AI mode? "It should be more profesional and welcoming" and when u click on it u get a pop up screen with the background blurred and it would say like a summary of how we use ai how everything is processed on ur phone locally which means nothing gets sent outside ur device also say how its environmentally cheaper and like other perks too. Say "For more information check out ____ AI policy or whatever profesional name u think is better" Make a link in legal center that expands on that and it tells more about it etc.

Back to the pop up it should give three options higher model middle model and lower model and a (Recomended) beside the model that the browser/app recommends based on specs and it should also have a green ring around that option.

Make a small chatbot that the user can talk to. It should be a small but noticeable icon. The chatbot can access information like users’ names, grades, bio hobbies skills stuff like that. It can also look at past events, current events, and events that are going to happen. It can also verify certificates if you give it the code.

I didn't tell it about the Welly thing So it still doesnt have a name yet. We could fix this add the name make a logo for it give it a personality stuff like that. Also, something I think is kind of important. Idk if Claude implemented this but after the user downloaded the model there is some sort of pre instructions given to the model, right? We aren't just giving them the model, I think. It should be tailored personalized plus personality given instructions on what it should do what it shouldn't do [Important]. If it doesnt exist ask claude to create its own mega prompt with its own instructions to put for the chatbot [Only if it feels its necessary] If it might harm the AI fucntionality or be stupid don't do this then. Plus, I don't like how the AI is a circle in the bottom right corner. It looks like one of those sale chatbots you find on websites. Looks really generic and bad. Make a better way to access the AI without being boring but also being intentional. You can ask Claude to do this because it has the layout and ui and everything so itll figure it out by itself. I tried running the app on localhost:5173 when I did npm run dev but it doesnt show the AI thing? even tho I did npm run dev? Why? If it was? intentional.

These are some of the features I added to Welly without you. The Problem is I don’t know if it works as expected like it used to but with the new features. I want it to still be able to talk freely and make sure the punctuation problem is fixed too. I want every single response from the AI to make perfect and proper sense and it should be really good. You can also change the UI too to make it better. Use the frontend-design skill to help with UI for Welly. And genuinely make Welly the best. Be detailed and specific got it?:


Ok so now i think that welly should have its own spot on the menu bar. its an important part of the app and I think it deserves much more than a small box and a small tiny three dot logo. The logo doesn’t even make sense and doesn’t show the "AI Part" right now. I’m fine if u use the same Spark icon u used for oppertunities near you in the Discover place. It should have its own part of the app. Conversation history? Make it fully integrated and perfected in the app. Make sure it looks good on both laptop, mobile, and all other screen orientations got it?
 
The menu bar might look cramped on the phone because of the new Welly AI menu icon. I want you to make it so that the bar on the phone doesn’t look crammed and everything looks perfect like a proper mobile app. It should look exactly like a mobile app.

I like how Welly can be Standared and On Device but like the names are kinda misleading. Give the names more thought and make it more obvious (although on device ai is fine).

Also it’s kinda weird how you have to go to settings to find the on device option. Make a button on the welly page [Like maybe right beside the name Welly] that takes u to the same page so u can see if u can download welly or not and you can just download it.

Also I think that the On Device AI lost the touch it had before. Before it could talk properly and have a proper sentence [With proper grammer] Now if the message limit Is reached it moves the word and punctuation to the next text output. Make it so that Welly’s responses aren’t limited to strictly a certain limit I think that might be the reason. But um if its not just fix it so that Welly’s responses are human sound friendly and make perfect sense.

Make sure the same applies for chatbot even tho there’s no local ai to back it up.


Find volunteering opportunities near me


Sometimes it defaults to Welly Chat for some reason even if im on AI mode. The verify certificate button should be an actual button right now it’s only text but make it look like a button. Im fine with the placement ig I don’t mind it. I think that a verify certificate link however shouldn’t exist below welly where it says “nothing changes without your confirmation” I do think a small legal disclaimer would fit its place tho where it says nothing leaves your device (which it does), and also still don’t type in sensitive information (because even though we don’t see it its still good practice) and also that this AI makes mistakes (a lot actually) its only meant to be for like helping you with the volunteering stuff.

I think adding something like that (in ur way and in ur choice) would help the app a little bit especially since Welly is still a prototype.


Didn’t make it so that you can switch between On Device Mode and Local AI seamlessly? There’s the drop down menu and it should be able to click between the modes to seamlessly change through them. If your clicking the AI mode for the first time it should take u to the screen to download it but other than that I feel like switching between them should be easy.

Your not committing it with my GitHub account btw. It shows Mahit Pulavarthi on the history but not my profile picture or my profile: This is my profile for reference

If ask for volunteering oppertunities near you the chatbot/AI shouldn’t ask for ur location (obviously) it should use location if already given through the app or tell the user to allow app to access location. Never ask the User to type in personal information into that chat [Even If its on device] it just makes us look sus.

Also, Speaking of verifying certificates there’s no way to go to /verify unless u go to the specific link. It’s not mentioned anywhere on the Home Screen or in any of the menu bar icons. I want you to add the certificate validation button somewhere (but not in the menu bar tho) it should be small but exist somewhere got it? In any one of those 4 icons. Depends on where u think it fits best.


WeVolunteer logo looks really ugly. Set the W to be in its own box. green background white W with checkmark. Mimic the previous WV logo but instead of WV just put the W Checkmark logo inside it instead. You might already have this somewhere just add it. Also add it to the emails too. I dont like the current WeVolunteer white text like the white text is fine it just shouldn’t be the only logo there should be green box with small logo and the white text should be the name got it?

When previewing roles as mod [such as student it should take me to dashboard instead of just staying on mod or admin cuz u get a 401 error which makes sense your previewing as a student you shouldn’t be able to see it. Just make sure its consistent with all previews its a simple thing when user tries to preview set preview and then make them view dashboard page got it?]

Admin page all the text is underlined. It looks kinda ugly I might need you to fix that for me before we finish it.

Next:

Make it so that Users can upload pdf and audio to messages. Whenever uses type stuff to each other or when organizers send anouncement they can also send image or audio… like instagram.

After that:

TODO: Lets work on Welly a bit more if we haven’t reached the limit



Email Stuff I have to worry about:
Profile picture on the custom domain emails.



Legal stuff I’m thinking about:



Should have proper ADA Compliance (For Handicapped Users). Search up what ADA Compliance you think my app should do and write a detailed specific plan for Claude to maybe add to my app. Ask Claude also to conduct its own research so it’ll understand what it has to do too. My main goal is that the app should be ADA compliant. You give a head start to it [with a detailed implementation plan] and Claude should figure out the best way there with its own research.






Idk but maybe thinking of adding?
DMCA Policy?
EULA Policy?

One thing I Wanna know is how far does the legal section go? Does it say stuff like no DDOS or is that just assumed? Not saying that there needs to be it but im just asking for a volunteering app how secure is it? Would u say that students should be allowed to automate applying to different events? And cancel the ones they don’t? Not saying this is right or wrong but I just want to think about it.

When I say Automation of Volunteering applicaition im not saying we should do it. Im asking should users be allowed to do it? should we say something in the legal center? Auto select still works but like imagine some smart kid decides to make an ai automation that checks its calendar see what slots its free find events in those slots apply to all see the ones it gets chosen in. cancels overlapping slots and updates calendar? would that be fair? im not saying if that is or if it isnt but like think about that

If you think about it I think we should factor in pending applications in our auto select feature too. Maybe its just a thought but if its a good idea add it else dont. Rate limit people so they can only apply to like 10 events at once (Not including shifts).

The App doesnt have an Acceptable Use Policy (AUP) but there are multiple documents already in the legal center. So like just check if we need an AUP and I noticed that the documents talk about community policies but not stuff like rate limiting disrupting services to others DDOS stuff like that. Idk tho its your choice to add it if you want but add it only if u genuinely think that it might be necessary.

Make sure that comments orgs keep or messages or any user typing stuff on the website doesn’t get executed XSS or smth. Prompt injecting Welly? Is that a possibility?
Make sure file upload for pfp is under 5kb and safe [doesnt execute and isn’t to large]

I want you to also like refactor the legal center I think when I say this I mean like group the documents more properly. See if things overlap if you can split stuff or if you think we should merge stuff. Its completely up to you. If you want to make things stay exactly the same Im fine with that too. 


Use the legal skill to help you with all of this if necessary

Legal

Source
Marketplace (Knowledge Work)
Version
1.3.0
Author
Anthropic
Last updated
Aug 13
Description
Speed up contract review, NDA triage, and compliance workflows for in-house legal teams. Draft legal briefs, organize precedent research, and manage institutional knowledge.

Invoke by typing / in chat, or let Claude use them automatically for relevant tasks.
/brief
Generate contextual briefings for legal work — daily summary, topic research, or incident response. Use when starting your day and need a scan of legal-relevant items across email, calendar, and contracts, when researching a specific legal question across internal sources, or when a developing situation (data breach, litigation threat, regulatory inquiry) needs rapid context.
/compliance-check
Run a compliance check on a proposed action, product feature, or business initiative, surfacing applicable regulations, required approvals, and risk areas. Use when launching a feature that touches personal data, when marketing or product proposes something with regulatory implications, or when you need to know which approvals and jurisdictional requirements apply before proceeding.
/legal-response
Generate a response to a common legal inquiry using configured templates, with built-in escalation checks for situations that shouldn't use a templated reply. Use when responding to data subject requests, litigation hold notices, vendor legal questions, NDA requests from business teams, or subpoenas.
/legal-risk-assessment
Assess and classify legal risks using a severity-by-likelihood framework with escalation criteria. Use when evaluating contract risk, assessing deal exposure, classifying issues by severity, or determining whether a matter needs senior counsel or outside legal review.
/meeting-briefing
Prepare structured briefings for meetings with legal relevance and track resulting action items. Use when preparing for contract negotiations, board meetings, compliance reviews, or any meeting where legal context, background research, or action tracking is needed.
/review-contract
Review a contract against your organization's negotiation playbook — flag deviations, generate redlines, provide business impact analysis. Use when reviewing vendor or customer agreements, when you need clause-by-clause analysis against standard positions, or when preparing a negotiation strategy with prioritized redlines and fallback positions.
/signature-request
Prepare and route a document for e-signature — run a pre-signature checklist, configure signing order, and send for execution. Use when a contract is finalized and ready to sign, when verifying entity names, exhibits, and signature blocks before sending, or when setting up an envelope with sequential or parallel signers.
/triage-nda
Rapidly triage an incoming NDA and classify it as GREEN (standard approval), YELLOW (counsel review), or RED (full legal review). Use when a new NDA arrives from sales or business development, when screening for embedded non-solicits, non-competes, or missing carveouts, or when deciding whether an NDA can be signed under standard delegation.
/vendor-check
Check the status of existing agreements with a vendor across all connected systems — CLM, CRM, email, and document storage — with gap analysis and upcoming deadlines. Use when onboarding or renewing a vendor, when you need a consolidated view of what's signed and what's missing (MSA, DPA, SOW), or when checking for approaching expirations and surviving obligations.
Try asking...
Review a contract against our playbook

Triage an incoming NDA
Prep a briefing for my next meeting
Assess legal risk on an incoming request


Once an organizer finalized hours it should be finalized (No takebackies) Unless the organizer didn’t like close out of the event If you get what im saying. Like if they finalize it and then closes the event u can’t unchange it but if u do mistakenly did something and u didn’t close the event (yet) u can still change them.

WHEN
Tue, Aug 18
1:00 PM – 7:00 PM
WHERE
[Reichler Park](https://maps.apple.com/?daddr=Reichler%20Park&dirflg=d)

[(opens directions in a new tab)](https://maps.apple.com/?daddr=Reichler%20Park&dirflg=d)
APPLICATIONS CLOSE
Sat, Sep 5, 12:27 PM
Next week
Every shift must have an adult volunteer due to cooking/grilling. The remaining slots can be taken by either high school volunteers, or additional parents. We are requesting that each family signs up for at least one time slot. Thank you!

Why does the application close Sept 5 but the event is Aug 18? Check If its right?

When creating a new event the catagory drop down menu is kinda narrow like those aren’t the only volunteering oppertunities and it certainly doesnt group most of them properly. 

The Application date date box doesnt use the custom date picker we made for the app. Plus when u click on it it prompts u to enter the numbers yourself instead of just showing the date picker and letting u do it the easier way.

Oo also when u make an event the apply button is at the bottom and like people might miss it and think that when they click request they already requested the event. Maybe change the text to say Select and Selected once clicked and itll stay like that until u click the button where it would then change to the regular yellow Awaiting Decision text and the regular Withdraw button.

Add a bit of gap between the tags and the green box (its kinda close just seperate it a tiny bit its the small details that count right?)

Use Upstash for Redis: Specifically Caching, Session Management, Rate Limiting, Leaderboard, and Chat. Research in depth the functionality of Uptash and the free tier specifically. Write a prompt to claude asking it to conduct its own extensive research and what all features are there and viable for the app and to implement all.


Going to focus on scaling too:
Cashing - Use Redis?
Async Jobs - Heavy jobs should be queued behind the scenes
Fast Database Queries
Load Testing - Stress test the app
Horizontal Scaling?

These should be added throughout the app and I want to make the app as efficient and effective as possible. Research on how to add them and check if there any other apps that we can use to add all these which have free tiers. Check if its reasonable to add and if it is then tell the process to add them and add it. 

I want a super admin page specifically for admins. It should be in the mod center or the special page only visible to owners (I forgot the page but I think its there). If its not there just add a button in the dash-page. It should route to /owner or some properly named webpage (Maybe not that but a reasonable good name). And should be a dashboard for allll the other apps that we’re adding.  Specifically Betterstacks and Amplitude. It should be fit for the owner and its sole purpose is to make life easier for the owner instead of visiting all these apps for their specific thing. If possible add the controls to the webpage but if not just add links that route to that page. But search it up and make sure that its possible and as a last resort it should do the rerouting but else not.

Think about adding Upstash and Pinecone too but If it doesnt seem appropriate then just don’t add it ok? Maybe you could add button reroutings for these on the owner webpage instead but its ur choice. The webpage’s main idea is BetterStacks and Amplitude for Analytics and Error Tracking. IF IT ALSO USES THE LIMIT OR LIKE ISNT FREE THEN DON’T DO IT. THATS A HARD CONSTRAINT.

I want you to also kinda focus on the view certificates page. I do want you to improve it make it look way better. Make the download button different and the share certificate button also different. Share certificate button should give options to copy link or to share on common social media platforms (Like how all share buttons work) Also should be an option to share with direct message people too I think that would be a thoughtful add. So don’t use the default pdf viewer create your own viewer which complements the app theme and fits perfectly inside it. It should look like its built for the app. Should also work light mode and dark mode switch acordingly remember that. Make it 1000% perfect got it?

Stripe? Should we have a donation page? Maybe ill add that after launch later when the app has more people.






Add Share Links to Organizations too

Should be like certificate share links basically I want the UI to match and it should all look intentional

If a user clicks on the link it’ll take them to the organization where they can view it but if they click the join button it’ll take them to a pop up that says log in or sign up if not a user else it lets them join the organization.

Organizations should have like a couple of security settings. It should be like you can make it so that only if u can share the organization link you can join the group. Maybe a setting limiting who can send invites. A request button instead of join for invite only clubs where people who click the link or just searched up the club can “request to join the organization and a student org or a org can accept that request” I don’t really like how the Organization pages are laid out I want you to use the /design skill and the /frontend-design skill to redesign the organization pages and make it look actually good like its own separate part of the app got it?




Also for the location permission notification I like how it’s placed there. Maybe we should introduce other notifications (only some so it doesn’t become crowded and looks ugly). I was thinking like if I change a document in the legal center (with the UI I said or through you doesn’t matter) whenever there is a bump in the version number then till say smth like ____ changed view how its changed but it should be the same look/ui as the location permission notification don’t make it look different because then it’ll look weird and that I designed notifications for two separate apps when I in fact didn’t. If you click on view document, it’ll take you to the document page in case you click the X symbol, it’ll dismiss the notification. Ofc this is only for non-serious changes or like minor changes got it? We should already have a system, please check it, for serious changes which require the user to again give their acceptance. If it’s that serious ignore the notification. Don’t even show it because I don’t want it to be shown twice annoyingly. If that system isn’t in place basically I wanted it so that it’ll popup in the screen blur the dashboard menu app basically the app in the background a green rectangular box in the middle center of the screen that’ll say a important document changed. Create the text yourself, for any of these notification boxes or this screen create the text yourself and make it look really really professional but also nice, It should say Document Changed [View Document] Accept Changes Sign Out. I want it so that if you do close the location permission notification or give location access (which ever one happens first) it’ll not show the notification and the whole app moves up covering up the space the notification originally was. This is because once you close the notification there’s a small weird gap on top of the app which looks kinda uncomfortable. I want you to make sure that from a user perspective the app always looks neat and good like an actual proper profesional app got it?



Add Upstash, Pinecone APIs for the Owner Center too. Make sure they work as well. Got it? Now after that we’ve finished with all external API stuff outside the app. I want it to check everything involving the external Apis and make sure it didnt work or smth changed it so it doesn’t work now. Make sure you check for all got it?



Ask the AI to go through the entire program and find places where stuff could be improved to be more efficient and effective stuff like that. Basically I want you to look at other professional apps. Social Media Apps Communication Apps Education Apps like Sign Up Genius. Look at what those apps have that my app doesn’t. I’m not just talking about features [Although Features would still be good]. I’m basically talking about loopholes and stuff that doesn’t make sense. What if I have a whole route like /events but there’s no way or no button to go to that? That’s stupid right? Obviously it works for my app but I’m asking you to look for non-obvious things that are in my app but aren’t working. Think like a Student, An Organizer, an admin. What’s not there that just doesn’t make sense like why this app doesn’t have it or why this type of situation isn’t possible? If anything looks uncomfortable to look at or like its placed weirdly, possibly because that feature was added later and we had to just place it there, you can re-change the whole thing at the end since there’s no more features to add. Make it look perfect not like things were just stacked onto each other. DON’T FORGET ANY FEATURE OR DETAIL in this process got it? I’m giving you permission to change the menu bars too to make it look better or like more profesional apps. You can place stuff wherever you want wherever you feel like it’s worth it. This is not a design change, the design change is later, but rather where we place the features themselves. Got it?



Look throughout the entire app for unfinished work too. TODOs incomplete stuff anything you find I want to work on that too as a final coding pass for the app. Everything should be complete and working. After that finally one final Audit of everything in this app so far. It should be extremely detailed and complete and be the best audit possible for this app. Since it’s the last it should be for every single line of code in this app, maybe not literally if inefficient but if it’s not a bad idea do it else just do it somehow. Check if the entire app works tho btw. Like I’m talking about another user’s verification where you create a bunch of Students, Organizers, Pending Organizers, Admins, etc., and test out all features of the app I mean all of them. Create a bunch of events make students message each other message welly, message organizers, join events, organizations, and text in those. It should actually be the activity of like around 100 students throughout a week of continuous volunteering doing everything that the app is supposed to do. Got it?


Here’s the claude engineering skill it should probably use:

Engineering

Source
Marketplace (Knowledge Work)
Version
1.2.0
Author
Anthropic
Last updated
Aug 13
Description
Streamline engineering workflows — standups, code review, architecture decisions, incident response, and technical documentation. Works with your existing tools or standalone.

Invoke by typing / in chat, or let Claude use them automatically for relevant tasks.
/architecture
Create or evaluate an architecture decision record (ADR). Use when choosing between technologies (e.g., Kafka vs SQS), documenting a design decision with trade-offs and consequences, reviewing a system design proposal, or designing a new component from requirements and constraints.
/code-review
Review code changes for security, performance, and correctness. Trigger with a PR URL or diff, "review this before I merge", "is this code safe?", or when checking a change for N+1 queries, injection risks, missing edge cases, or error handling gaps.
/debug
Structured debugging session — reproduce, isolate, diagnose, and fix. Trigger with an error message or stack trace, "this works in staging but not prod", "something broke after the deploy", or when behavior diverges from expected and the cause isn't obvious.
/deploy-checklist
Pre-deployment verification checklist. Use when about to ship a release, deploying a change with database migrations or feature flags, verifying CI status and approvals before going to production, or documenting rollback triggers ahead of time.
/documentation
Write and maintain technical documentation. Trigger with "write docs for", "document this", "create a README", "write a runbook", "onboarding guide", or when the user needs help with any form of technical writing — API docs, architecture docs, or operational runbooks.
/incident-response
Run an incident response workflow — triage, communicate, and write postmortem. Trigger with "we have an incident", "production is down", an alert that needs severity assessment, a status update mid-incident, or when writing a blameless postmortem after resolution.
/standup
Generate a standup update from recent activity. Use when preparing for daily standup, summarizing yesterday's commits and PRs and ticket moves, formatting work into yesterday/today/blockers, or structuring a few rough notes into a shareable update.
/system-design
Design systems, services, and architectures. Trigger with "design a system for", "how should we architect", "system design for", "what's the right architecture for", or when the user needs help with API design, data modeling, or service boundaries.
/tech-debt
Identify, categorize, and prioritize technical debt. Trigger with "tech debt", "technical debt audit", "what should we refactor", "code health", or when the user asks about code quality, refactoring priorities, or maintenance backlog.
/testing-strategy
Design test strategies and test plans. Trigger with "how should we test", "test strategy for", "write tests for", "test plan", "what tests 




Massive Front-End Revamp:
Use the color scale photos I have saved on my phone and we’re going to revamp the site specifically the buttons stuff like that. We’re going to make it not vibe coded and use the frontend-design skill a long with any other skill to create a good frontend.
I would also suggest adding motion and animations now since our site doesn’t have that much.
Include free sites map servers for react components and motion and animation to include into the site

This might also be a good change to conduct that “Launching a Vibe-Coded App” checklist that I listed below so that the AI understands the site. The mistakes it makes and using a deep research it can try to fix my app so it doesn’t feel “vibe coded”.

I would say instead of putting this in Claude code use Claude Design for this instead.


Design Skill:

Source
Marketplace (Knowledge Work)
Version
1.2.0
Author
Anthropic
Last updated
Aug 13
Description
Accelerate design workflows — critique, design system management, UX writing, accessibility audits, research synthesis, and dev handoff. From exploration to pixel-perfect specs.

Invoke by typing / in chat, or let Claude use them automatically for relevant tasks.
/accessibility-review
Run a WCAG 2.1 AA accessibility audit on a design or page. Trigger with "audit accessibility", "check a11y", "is this accessible?", or when reviewing a design for color contrast, keyboard navigation, touch target size, or screen reader behavior before handoff.
/design-critique
Get structured design feedback on usability, hierarchy, and consistency. Trigger with "review this design", "critique this mockup", "what do you think of this screen?", or when sharing a Figma link or screenshot for feedback at any stage from exploration to final polish.
/design-handoff
Generate developer handoff specs from a design. Use when a design is ready for engineering and needs a spec sheet covering layout, design tokens, component props, interaction states, responsive breakpoints, edge cases, and animation details.
/design-system
Audit, document, or extend your design system. Use when checking for naming inconsistencies or hardcoded values across components, writing documentation for a component's variants, states, and accessibility notes, or designing a new pattern that fits the existing system.
/research-synthesis
Synthesize user research into themes, insights, and recommendations. Use when you have interview transcripts, survey results, usability test notes, support tickets, or NPS responses that need to be distilled into patterns, user segments, and prioritized next steps.
/user-research
Plan, conduct, and synthesize user research. Trigger with "user research plan", "interview guide", "usability test", "survey design", "research questions", or when the user needs help with any aspect of understanding their users through research.
/ux-copy
Write or review UX copy — microcopy, error messages, empty states, CTAs. Trigger with "write copy for", "what should this button say?", "review this error message", or when naming a CTA, wording a confirmation dialog, filling an empty state, or writing onboarding text.
Try asking...
Get structured feedback on a design

Generate developer handoff specs from a Figma file
Run a WCAG accessibility audit
Write UX copy for a screen or flow
Synthesize user research into actionable themes


This is the claude design skill and all the things it has. I want it to use these skills along with the frontend design skill to refactor the UI to make it not AI-y and actually make the website look nice.



Here’s the frontend skill too:

Frontend design


Source
Marketplace (claude-plugins-official)
Author
Anthropic
Description
Frontend design skill for UI/UX implementation

Invoke by typing / in chat, or let Claude use them automatically for relevant tasks.
/frontend-design
Guidance for distinctive, intentional visual design when building new UI or reshaping an existing one. Helps with aesthetic directio



It should be a massive revamp and maybe I use ChatGPT’s deep research feature to make ChatGPT research more. Include that in the prompt and ask claude to use that research or for it to conduct its own search.



I should probably add meta description for each public page right? Add Sitemap + Connect Search Console


Vercel
I was thinking we make it so that the app lives inside [app.wevolunteers.org](http://app.wevolunteers.org) but then the welcome or the amazing design or like introduction page shows up at [wevolunteers.org](http://wevolunteers.org). It separates the actual app with the design and marketing page. Thats what a lot of other companies do like notion. If you want search it up.

Add Cloudfare DNS for the app. Make sure its secure and shi.


Services I can use:

Claude = coding. ($20/mo) 
Supabase = backend. (Free) 
Vercel = deploying. (Free) 
Namecheap = domain. ($12/yr) 
Stripe = payments. (2.9%/transaction) 
GitHub = version control. (Free) 
Resend = emails. (Free) 
Clerk = auth. (Free) 
Cloudflare = DNS. (Free) 
Amplitude= analytics. (Free) 
BetterStack = error tracking. (Free) 
Upstash = Redis. (Free) 
Pinecone = vector DB. (Free)

——————THIS IS EVERYTHING——————

BEGIN NOW.
````

---

## Inputs referenced but not supplied

Recorded so their absence is not mistaken for oversight:

- **The two PDFs** ("Im attaching both the pdfs") — the certificate and
  transcript print samples. Not in this record; the requests they illustrate
  are stated in words and are verifiable without them.
- **The colour-scale photos** on the owner's phone, for the frontend revamp.
- **The "Launching a Vibe-Coded App" checklist** ("that I listed below") — not
  in the pasted text.
- **The GitHub profile** ("This is my profile for reference") — not needed;
  the commit-identity question is answerable from `git log` alone.

The last three belong to the separate revamp engagement (owner decision,
2026-09-30), except the profile, which is resolved.
