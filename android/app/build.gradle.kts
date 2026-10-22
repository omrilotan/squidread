plugins {
	id("com.android.application")
}

android {
	namespace = "com.omrilotan.squidread"
	compileSdk = 37

	defaultConfig {
		applicationId = "com.omrilotan.squidread"
		minSdk = 24
		targetSdk = 36
		// Only ever increases; devices already have test builds up to 5 installed.
		versionCode = 8
		versionName = "1.0.0-rc-20261022"
	}

	// Readium's page script and styles load into every chapter; stored uncompressed, they are
	// read straight from the APK instead of being inflated each time.
	androidResources {
		noCompress += listOf("readium-reflowable.js", ".css")
		// The app is in English only; the libraries' translations of their own strings would
		// never show.
		localeFilters += "en"
		// Readium assets this app never uses: the player for Divina comics (only EPUBs open
		// here), and fonts that load only when chosen as the book's font, which Squidread
		// doesn't offer. The rest are aapt's defaults.
		ignoreAssetsPattern = listOf(
			"!.svn", "!.git", "!.ds_store", "!*.scc", ".*", "<dir>_*", "!CVS", "!thumbs.db", "!picasa.ini", "!*~",
			"<dir>divina", "AccessibleDfA.otf", "iAWriterDuospace-Regular.ttf", "OpenDyslexic-Regular.otf",
		).joinToString(":")
	}

	// Release signing comes from ~/.gradle/gradle.properties, never from the repo.
	val keystore = providers.gradleProperty("SQUIDREAD_KEYSTORE").orNull
	if (keystore != null) {
		signingConfigs.create("release") {
			storeFile = file(keystore)
			storePassword = providers.gradleProperty("SQUIDREAD_KEYSTORE_PASSWORD").get()
			keyAlias = providers.gradleProperty("SQUIDREAD_KEY_ALIAS").get()
			keyPassword = providers.gradleProperty("SQUIDREAD_KEY_PASSWORD").get()
		}
	}

	buildTypes {
		release {
			signingConfig = signingConfigs.findByName("release")
			// Smaller, faster code for low-power e-ink devices.
			isMinifyEnabled = true
			isShrinkResources = true
			proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
		}
	}

	compileOptions {
		sourceCompatibility = JavaVersion.VERSION_17
		targetCompatibility = JavaVersion.VERSION_17
		// Readium uses java.time and other newer JDK APIs on old Android versions.
		isCoreLibraryDesugaringEnabled = true
	}
}

// Kotlin's reflection library is a third of the app's code, and Readium uses it in one place
// only; see proguard-rules.pro.
configurations.matching { it.name.endsWith("RuntimeClasspath") }.configureEach {
	exclude(group = "org.jetbrains.kotlin", module = "kotlin-reflect")
}

dependencies {
	coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
	implementation("org.readium.kotlin-toolkit:readium-shared:3.4.0")
	implementation("org.readium.kotlin-toolkit:readium-streamer:3.4.0")
	implementation("org.readium.kotlin-toolkit:readium-navigator:3.4.0")
	implementation("androidx.appcompat:appcompat:1.8.0")
	implementation("androidx.fragment:fragment-ktx:1.9.0")
	implementation("androidx.recyclerview:recyclerview:1.4.0")
	implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.11.0")
	// Applies the libraries' baseline profiles on install (including sideloads) for faster startup.
	implementation("androidx.profileinstaller:profileinstaller:1.4.1")
}
