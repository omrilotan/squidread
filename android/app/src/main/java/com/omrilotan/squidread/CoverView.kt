package com.omrilotan.squidread

import android.content.Context
import android.util.AttributeSet
import androidx.appcompat.widget.AppCompatImageView

/** Book cover with a fixed 2:3 portrait shape, so the grid never reflows as covers load. */
class CoverView(context: Context, attrs: AttributeSet?) : AppCompatImageView(context, attrs) {
	override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
		val width = MeasureSpec.getSize(widthMeasureSpec)
		setMeasuredDimension(width, width * 3 / 2)
	}
}
