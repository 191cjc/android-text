var testswf = '/jss/objtest.swf';
document.write ("<div id='testflashplayer'><OBJECT ID='testplayer' classid='clsid:D27CDB6E-AE6D-11cf-96B8-444553540000' codebase='//imga4.5054399.com/upload_pic/2022/swflash.cab#version=9,0,28,0' width='10' height='10'>");document.write ("<PARAM NAME='movie' VALUE='" + testswf + "'>");document.write("<embed id='testplayer1' name='testplaye' src='" + testswf + "' quality='high' pluginspage='//www.macromedia.com/go/getflashplayer' type='application/x-shockwave-flash' width='10' height='10'></embed>");document.write ("<PARAM NAME='quality' VALUE='high'>");document.write ("</OBJECT></div>");
var flashenabled = 0;
var isiebrowsersymbol = 0;

if(!!window.ActiveXObject || "ActiveXObject" in window){
  isiebrowsersymbol = 1;
}else{
  isiebrowsersymbol = 0;
}

if(typeof(isHTML5)=="undefined"){
	isHTML5 = 0;
}
	

if(isHTML5==0){
	var trycount = 0;
	//console.info("检测到flash插件，非ie浏览器");
	//尝试调用flash内部的checkflash方法 每隔x秒读取一次
	var myTimer = function (callback) {
		var testpoint = setInterval(function(){
			try{
				//console.info("尝试调用flash函数");
				if(isiebrowsersymbol==1){
					flashenabled = document.getElementById("testplayer").checkflash();
				}else{
					flashenabled = document.getElementById("testplayer1").checkflash();
				}
				//console.info("调用结果"+flashenabled);
				callback(1);
				clearInterval(testpoint);
			}catch(e){  
				//console.info("x毫秒重试");
				trycount++;
				//console.info("重试了"+trycount+"次");
				if(trycount>5){
					if(isiebrowsersymbol==1){
						showBlockFlashIE();
					}else{
						showBlockFlash();
					}
					clearInterval(testpoint);
				}
			}
		},100);
	}
	myTimer(function (val) {
		flashenabled = val;
	});
}

var old_addiv_html = document.getElementById("addiv").innerHTML ;
var old_swfdiv_html = document.getElementById("swfdiv").innerHTML ;
function showBlockFlash(){
	var swfdivwidth = "100%";
	var swfdivheight = "100%";
	var showwinstrs = "<iframe id='flash22' align='center' width='"+swfdivwidth+"' height='"+swfdivheight+"' src='/loadimg/blockflashtip.html' frameborder='no' border='0' marginwidth='0' marginheight='0' scrolling='no'></iframe>";
	document.getElementById("swfdiv").style.paddingTop = "0px";
	document.getElementById("swfdiv").innerHTML = showwinstrs;
	document.getElementById("addiv").innerHTML = showwinstrs;
	document.getElementById("ifull").style.display = "none";
	document.getElementById("loadingdiv").style.display = "none";
}

function showBlockFlashIE(){
	var swfdivwidth = "640px";
	var swfdivheight = "480px";
	_w = 640;
	_h = 480;
	_wset = 640;
	_hset = 480;
	autoFixScreen=0;
	var showwinstrs = "<iframe id='flash22' align='center' width='"+swfdivwidth+"' height='"+swfdivheight+"' src='/loadimg/noInstallFlashIE.html' frameborder='no' border='0' marginwidth='0' marginheight='0' scrolling='no'></iframe>";
	document.getElementById("swfdiv").style.paddingTop = "0px";
	document.getElementById("swfdiv").innerHTML = showwinstrs;
	document.getElementById("addiv").innerHTML = showwinstrs;
	document.getElementById("ifull").style.display = "none";
	document.getElementById("loadingdiv").style.display = "none";
}

function closeBlockFlash(){
	document.getElementById("swfdiv").innerHTML = old_swfdiv_html;
	document.getElementById("addiv").innerHTML = old_addiv_html;
}