I like a logfile viewer done in node.js using bootstrap from CDN and plain javascript in the frontend. In bin/logviewer is the starter, in server/js/ are the actual
javascript files; it'd be good to use templates for the HTML parts in server/html/ that are plain HTML. The log viewer should be able to view multi megabyte logfiles
without loading everything into the browser. bin/logviewer should print a help when called without arguments or with -h, --help or -? . It should use MacOS open to open
the log viewer in the browser on start, choosing a random free port starting from 3223. That logic should be in bin/logviewer. The bin/logviewer starter script should be
able to be symlinked somewhere yet still locate it's server directory. For a start it should just display the logfile with a scroll bar, but the scroll bar should span
the whole file - without loading the whole file into the browser (yet). It should be possible via switch to make it wrap lines or not. If wrapping is off it should have
a (normal) horizontal scroll bar if it's larger than screen width. Screen space should be used economically - no large empty spaces around the display.

