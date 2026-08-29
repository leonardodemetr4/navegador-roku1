sub init()

    m.address =
        m.top.findNode(
            "address"
        )

    m.pagePoster =
        m.top.findNode(
            "pagePoster"
        )

    m.cursor =
        m.top.findNode(
            "cursor"
        )

    m.cursorShadow =
        m.top.findNode(
            "cursorShadow"
        )

    m.status =
        m.top.findNode(
            "status"
        )


    m.serverBase =
        "https://navegador-roku1-1.onrender.com"


    m.session =
        "roku43plus"


    m.currentUrl =
        "https://example.com"


    m.pendingText =
        ""


    m.cx =
        640


    m.cy =
        359


    m.imageSerial =
        0


    m.top.SetFocus(
        true
    )


    openPage()

end sub


' ==========================================
' TECLADO
' ==========================================

sub showKeyboard()

    d =
        CreateObject(
            "roSGNode",
            "KeyboardDialog"
        )


    d.title =
        "Pesquisar ou digitar endereco"


    d.text =
        ""


    d.buttons =
        [
            "Abrir",
            "Cancelar"
        ]


    d.ObserveField(
        "text",
        "onKeyboardText"
    )


    d.ObserveField(
        "buttonSelected",
        "onKeyboardButton"
    )


    m.top.dialog =
        d

end sub


sub onKeyboardText(
    e as Object
)

    m.pendingText =
        e.GetData()

end sub


sub onKeyboardButton(
    e as Object
)

    if e.GetData() = 0

        value =
            m.pendingText.Trim()


        if value <> ""

            lower =
                LCase(
                    value
                )


            if Left(lower, 7) <> "http://" and Left(lower, 8) <> "https://"

                if Instr(1, value, ".") = 0

                    value =
                        "https://www.bing.com/search?q=" +
                        value.EncodeUriComponent()

                else

                    value =
                        "https://" +
                        value

                end if

            end if


            m.currentUrl =
                value


            openPage()

        end if

    end if


    m.top.dialog =
        invalid

end sub


' ==========================================
' ABRIR PAGINA
' ==========================================

sub openPage()

    m.address.text =
        m.currentUrl


    m.status.text =
        "Abrindo pagina..."


    requestUrl =
        m.serverBase +
        "/v3/open?session=" +
        m.session


    requestUrl =
        requestUrl +
        "&url=" +
        m.currentUrl.EncodeUriComponent()


    downloadImage(
        requestUrl
    )

end sub


' ==========================================
' CLIQUE
' ==========================================

sub clickPage()

    px =
        Int(
            (m.cx - 35) *
            1280 /
            1210
        )


    py =
        Int(
            (m.cy - 120) *
            720 /
            505
        )


    if px < 0 then
        px = 0
    end if


    if py < 0 then
        py = 0
    end if


    if px > 1279 then
        px = 1279
    end if


    if py > 719 then
        py = 719
    end if


    m.status.text =
        "Clicando..."


    requestUrl =
        m.serverBase +
        "/v3/click?session=" +
        m.session


    requestUrl =
        requestUrl +
        "&x=" +
        px.ToStr()


    requestUrl =
        requestUrl +
        "&y=" +
        py.ToStr()


    downloadImage(
        requestUrl
    )

end sub


' ==========================================
' VOLTAR
' ==========================================

sub goBack()

    m.status.text =
        "Voltando..."


    requestUrl =
        m.serverBase +
        "/v4/back?session=" +
        m.session


    downloadImage(
        requestUrl
    )

end sub


' ==========================================
' ROLAGEM
' ==========================================

sub scrollPage(
    amount as Integer
)

    if amount > 0

        m.status.text =
            "Rolando para baixo..."

    else

        m.status.text =
            "Rolando para cima..."

    end if


    requestUrl =
        m.serverBase +
        "/v4/scroll?session=" +
        m.session


    requestUrl =
        requestUrl +
        "&dy=" +
        amount.ToStr()


    downloadImage(
        requestUrl
    )

end sub


' ==========================================
' DOWNLOAD DA IMAGEM
' ==========================================

sub downloadImage(
    requestUrl as String
)

    m.imageSerial =
        m.imageSerial + 1


    requestUrl =
        requestUrl +
        "&_roku=" +
        m.imageSerial.ToStr()


    task =
        CreateObject(
            "roSGNode",
            "ImageTask"
        )


    task.url =
        requestUrl


    task.fileId =
        m.imageSerial.ToStr()


    task.ObserveField(
        "localUri",
        "onImageReady"
    )


    task.ObserveField(
        "errorText",
        "onImageError"
    )


    m.imageTask =
        task


    task.control =
        "run"

end sub


' ==========================================
' NOVA IMAGEM
' ==========================================

sub onImageReady(
    e as Object
)

    uri =
        e.GetData()


    if uri <> invalid and uri <> ""

        m.pagePoster.uri =
            uri


        m.status.text =
            "Pagina carregada"

    end if

end sub


' ==========================================
' ERRO
' ==========================================

sub onImageError(
    e as Object
)

    errorMessage =
        e.GetData()


    if errorMessage = invalid or errorMessage = ""

        errorMessage =
            "Erro ao carregar pagina"

    end if


    m.status.text =
        errorMessage

end sub


' ==========================================
' CURSOR
' ==========================================

sub moveCursor(
    dx as Integer,
    dy as Integer
)

    m.cx =
        m.cx + dx


    m.cy =
        m.cy + dy


    if m.cx < 35 then
        m.cx = 35
    end if


    if m.cx > 1225 then
        m.cx = 1225
    end if


    if m.cy < 120 then
        m.cy = 120
    end if


    if m.cy > 605 then
        m.cy = 605
    end if


    m.cursor.translation =
        [
            m.cx,
            m.cy
        ]


    m.cursorShadow.translation =
        [
            m.cx - 4,
            m.cy + 4
        ]

end sub


' ==========================================
' CONTROLE REMOTO
' ==========================================

function onKeyEvent(
    key as String,
    press as Boolean
) as Boolean

    if not press

        return false

    end if


    if key = "left"

        moveCursor(
            -30,
            0
        )

        return true


    else if key = "right"

        moveCursor(
            30,
            0
        )

        return true


    else if key = "up"

        moveCursor(
            0,
            -26
        )

        return true


    else if key = "down"

        moveCursor(
            0,
            26
        )

        return true


    else if key = "OK"

        clickPage()

        return true


    else if key = "back"

        goBack()

        return true


    else if key = "fastforward"

        scrollPage(
            700
        )

        return true


    else if key = "rewind"

        scrollPage(
            -700
        )

        return true


    else if key = "options"

        showKeyboard()

        return true


    else if key = "replay"

        openPage()

        return true

    end if


    return false

end function
