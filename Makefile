.PHONY: site android android-release android-bundle

# Homebrew's JDK is keg-only; override if yours lives elsewhere.
export JAVA_HOME ?= /opt/homebrew/opt/openjdk@17

site:
	npx serve docs -l 5050

android:
	cd android && ./gradlew assembleDebug

android-release:
	cd android && ./gradlew assembleRelease

android-bundle:
	cd android && ./gradlew bundleRelease
